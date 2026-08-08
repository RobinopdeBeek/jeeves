import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import type { CardAttachmentStore } from "../attachments/card-library.js";
import { openDb, type Db } from "../db/index.js";
import { CardStore, type CardWithSteps } from "../cards/store.js";
import { EventBus, type JeevesEvent } from "./events.js";
import { ExecutionEngine } from "./engine.js";
import { RunStore } from "./run-store.js";
import type { AgentRunner, RunAgentOptions, RunEvent } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";

export type Script =
  | { events: RunEvent[]; finalize?: "plan" | "implement" }
  | { error: Error }
  | { gate: Promise<RunEvent[]>; finalize?: "plan" | "implement" };

export const ok = (): RunEvent[] => [
  { type: "log", line: "working…" },
  { type: "result", status: "finished" },
];

/** Successful Plan script — writes `.jeeves/plan.md`, no commits. */
export const planOk = (): Script => ({ events: ok(), finalize: "plan" });

/** Successful Implement script — reports a new HEAD, clean tree. */
export const implementOk = (): Script => ({
  events: ok(),
  finalize: "implement",
});

export function fakeRunner(scripts: Script[]) {
  const calls: Array<{ prompt: string; options: RunAgentOptions }> = [];
  const runner: AgentRunner = {
    async *run(prompt, options) {
      calls.push({ prompt, options });
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
          const kind = script.finalize ?? "plan";
          if (kind === "plan") {
            const planDir = path.join(options.worktreePath, ".jeeves");
            fs.mkdirSync(planDir, { recursive: true });
            fs.writeFileSync(
              path.join(planDir, "plan.md"),
              "# Plan\n\nTracer plan.\n",
            );
            await options.onFinalize({
              workspacePath: options.worktreePath,
              headSha: options.baseSha,
              baseSha: options.baseSha,
            });
          } else {
            await options.onFinalize({
              workspacePath: options.worktreePath,
              headSha: `${options.baseSha}-impl`,
              baseSha: options.baseSha,
            });
          }
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
    async createFrom(_branch, _baseSha, worktreePath) {
      fs.mkdirSync(worktreePath, { recursive: true });
    },
    async checkoutExisting(_branch, worktreePath) {
      fs.mkdirSync(worktreePath, { recursive: true });
    },
    async ensureBranch() {
      // No-op in harness — ExecutionEngine.ensureBranch tests stub this.
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
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-engine-"));
  const artifactStore = new ArtifactStore(db, artifactRoot);
  const store = new CardStore(db, artifactStore);
  const runStore = new RunStore(db);
  const events = new EventBus();
  const received: JeevesEvent[] = [];
  events.subscribe((e) => received.push(e));
  // Real app repo root so prompt templates under prompts/ resolve.
  const repoRoot = path.resolve(import.meta.dirname, "../..");
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
    },
  };
}

export function makeEngineWithRunner(
  harness: EngineTestHarness,
  runner: AgentRunner,
  worktrees: WorktreeLifecycle = fakeWorktrees(harness.artifactRoot),
  cardAttachments?: CardAttachmentStore,
) {
  const engine = new ExecutionEngine({
    store: harness.store,
    runs: harness.runStore,
    runner,
    worktrees,
    artifacts: harness.artifactStore,
    events: harness.events,
    repoRoot: harness.repoRoot,
    cardAttachments,
  });
  return engine;
}

export function makeEngine(
  harness: EngineTestHarness,
  scripts: Script[],
  cardAttachments?: CardAttachmentStore,
) {
  const { runner, calls } = fakeRunner(scripts);
  const engine = makeEngineWithRunner(harness, runner, undefined, cardAttachments);
  return { engine, calls };
}

export function queuedCard(harness: EngineTestHarness, title = "Rest timer"): CardWithSteps {
  const projectId = harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id;
  const card = harness.store.createCard(projectId);
  harness.store.updateCard(card.id, { title });
  return harness.store.decideKind(card.id, "standalone").card;
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
    async *run(_prompt, options) {
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
