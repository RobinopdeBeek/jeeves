import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { openDb, type Db } from "../db/index.js";
import { CardStore, type CardWithSteps } from "../cards/store.js";
import { EventBus, type JeevesEvent } from "./events.js";
import { ExecutionEngine } from "./engine.js";
import { RunStore } from "./run-store.js";
import type { AgentRunner, RunAgentOptions, RunEvent } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";

export type Script =
  | { events: RunEvent[] }
  | { error: Error }
  | { gate: Promise<RunEvent[]> };

export const ok = (): RunEvent[] => [
  { type: "log", line: "working…" },
  { type: "result", status: "finished" },
];

export function fakeRunner(scripts: Script[]) {
  const calls: Array<{ promptFile: string; options: RunAgentOptions }> = [];
  const runner: AgentRunner = {
    async *run(promptFile, options) {
      calls.push({ promptFile, options });
      const script = scripts.shift();
      if (!script) throw new Error("fake runner: no script left");
      if ("error" in script) throw script.error;
      const events =
        "gate" in script
          ? await abortable(script.gate, options.signal)
          : script.events;
      options.signal?.throwIfAborted();
      for (const event of events) {
        if (event.type === "log") {
          fs.appendFileSync(options.logPath, `${event.line}\n`);
        }
        if (event.type === "result" && event.status === "finished" && options.onFinalize) {
          const planDir = path.join(options.worktreePath, ".jeeves");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n\nTracer plan.\n");
          await options.onFinalize({
            workspacePath: options.worktreePath,
            headSha: options.baseSha,
            baseSha: options.baseSha,
          });
        }
        yield event;
      }
    },
  };
  return { runner, calls };
}

export function fakeWorktrees(root: string): WorktreeLifecycle {
  return {
    worktreePathFor(cardId) {
      return path.join(root, "worktrees", cardId);
    },
    async resolveRef() {
      return "abc123def456";
    },
    async create(_branch, _baseSha, worktreePath) {
      fs.mkdirSync(worktreePath, { recursive: true });
    },
    async remove(worktreePath) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    },
    async worktreeStatus(cwd, _options?) {
      const entries: string[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === ".jeeves") continue;
            walk(path.join(dir, entry.name), rel);
          } else if (!rel.startsWith(".jeeves/")) {
            entries.push(`?? ${rel}`);
          }
        }
      };
      if (fs.existsSync(cwd)) walk(cwd, "");
      return entries.join("\n");
    },
    async captureDiagnostics(cwd) {
      const status = await this.worktreeStatus(cwd);
      return {
        status,
        diff: status ? `diff --git a/${status.split("\n")[0]?.slice(3) ?? "x"}` : "",
        diffCached: "",
        headSha: "abc123def456",
      };
    },
    async cleanupOrphans() {},
  };
}

export interface EngineTestHarness {
  db: Db;
  store: CardStore;
  runStore: RunStore;
  artifactStore: ArtifactStore;
  events: EventBus;
  received: JeevesEvent[];
  artifactRoot: string;
  repoRoot: string;
  dispose: () => void;
}

export function createEngineHarness(): EngineTestHarness {
  const db = openDb(":memory:");
  const store = new CardStore(db);
  const runStore = new RunStore(db);
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-engine-"));
  const artifactStore = new ArtifactStore(db, artifactRoot);
  const events = new EventBus();
  const received: JeevesEvent[] = [];
  events.subscribe((e) => received.push(e));
  const repoRoot = path.join(os.tmpdir(), "jeeves-repo-root");
  fs.mkdirSync(repoRoot, { recursive: true });
  return {
    db,
    store,
    runStore,
    artifactStore,
    events,
    received,
    artifactRoot,
    repoRoot,
    dispose() {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

export function makeEngineWithRunner(
  harness: EngineTestHarness,
  runner: AgentRunner,
  worktrees: WorktreeLifecycle = fakeWorktrees(harness.artifactRoot),
) {
  const engine = new ExecutionEngine({
    store: harness.store,
    runs: harness.runStore,
    runner,
    worktrees,
    artifacts: harness.artifactStore,
    events: harness.events,
    repoRoot: harness.repoRoot,
  });
  return engine;
}

export function makeEngine(harness: EngineTestHarness, scripts: Script[]) {
  const { runner, calls } = fakeRunner(scripts);
  const engine = makeEngineWithRunner(harness, runner);
  return { engine, calls };
}

export function queuedCard(harness: EngineTestHarness, title = "Rest timer"): CardWithSteps {
  const projectId = harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id;
  const card = harness.store.createCard(projectId);
  harness.store.updateCard(card.id, { title });
  return harness.store.decideKind(card.id, "standalone");
}

export function stepStatus(harness: EngineTestHarness, cardId: string, stepKey: string) {
  return harness.store.getCard(cardId)!.steps.find((s) => s.key === stepKey)?.status;
}

export function expectDiagnosticAttachment(harness: EngineTestHarness, cardId: string) {
  const diag = harness.artifactStore.latest(cardId, {
    stepKey: "plan",
    round: 0,
    kind: "attachment",
  });
  expect(diag).toBeDefined();
  expect(harness.artifactStore.readBody(diag!)).toContain("Workspace diagnostics");
}

/** Runner that calls onFinalize after optional workspace setup. */
export function runnerWithFinalize(
  setup: (options: RunAgentOptions) => void,
  headSha?: (options: RunAgentOptions) => string,
): AgentRunner {
  return {
    async *run(_promptFile, options) {
      yield { type: "log", line: "working…" };
      fs.appendFileSync(options.logPath, "working…\n");
      setup(options);
      if (options.onFinalize) {
        await options.onFinalize({
          workspacePath: options.worktreePath,
          headSha: headSha?.(options) ?? options.baseSha,
          baseSha: options.baseSha,
        });
      }
      yield { type: "result", status: "finished" };
    },
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
    promise.then(resolve, reject);
  });
}
