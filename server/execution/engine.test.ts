import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { CardStore, type CardWithSteps } from "../cards/store.js";
import { EventBus, type JeevesEvent } from "./events.js";
import { ExecutionEngine } from "./engine.js";
import { RunStore } from "./run-store.js";
import type { AgentRunner, RunAgentOptions, RunEvent } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";

/**
 * Scripted fake AgentRunner. Each run() call consumes the next script in
 * FIFO order; a script either yields events, throws, or waits on a gate
 * so tests can control run lifetime.
 */
type Script =
  | { events: RunEvent[] }
  | { error: Error }
  | { gate: Promise<RunEvent[]> };

function fakeRunner(scripts: Script[]) {
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
      yield* events;
    },
  };
  return { runner, calls };
}

function fakeWorktrees(root: string): WorktreeLifecycle {
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
    async captureDiagnostics() {
      return { status: "", diff: "", diffCached: "", headSha: "abc123def456" };
    },
    async cleanupOrphans() {},
  };
}

const ok = (): RunEvent[] => [
  { type: "log", line: "working…" },
  { type: "result", status: "finished" },
];

describe("ExecutionEngine", () => {
  let db: Db;
  let store: CardStore;
  let runStore: RunStore;
  let events: EventBus;
  let received: JeevesEvent[];
  let artifactRoot: string;
  const repoRoot = path.join(os.tmpdir(), "jeeves-repo-root");

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    runStore = new RunStore(db);
    events = new EventBus();
    received = [];
    events.subscribe((e) => received.push(e));
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-engine-"));
    fs.mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function makeEngine(scripts: Script[]) {
    const { runner, calls } = fakeRunner(scripts);
    const engine = new ExecutionEngine({
      store,
      runs: runStore,
      runner,
      worktrees: fakeWorktrees(artifactRoot),
      events,
      artifactRoot,
      repoRoot,
    });
    return { engine, calls };
  }

  function queuedCard(title = "Rest timer"): CardWithSteps {
    const projectId = store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    const card = store.createCard(projectId);
    store.updateCard(card.id, { title });
    return store.decideKind(card.id, "standalone");
  }

  function stepStatus(cardId: string, stepKey: string) {
    return store.getCard(cardId)!.steps.find((s) => s.key === stepKey)?.status;
  }

  it("runs a queued Plan to done when the agent succeeds", async () => {
    const card = queuedCard();
    const { engine, calls } = makeEngine([{ events: ok() }]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(card.id, "plan")).toBe("done");
    expect(stepStatus(card.id, "impl")).toBe("pending");
    expect(stepStatus(card.id, "airev")).toBe("pending");

    const run = runStore.latestForStep(card.id, "plan");
    expect(run?.status).toBe("succeeded");
    expect(run?.skill).toBe("slice-3-tracer");
    expect(run?.logPath).toContain(path.join("cards", card.id, "0"));

    expect(calls).toHaveLength(1);
    expect(calls[0].promptFile).toContain(
      path.join("prompts", "execution", "slice-3-tracer.md"),
    );
    expect(calls[0].options.cwd).toBe("C:/target-repo");
    expect(calls[0].options.branch).toBe(`jeeves/card-${card.id}`);
    expect(calls[0].options.worktreePath).toContain(path.join("worktrees", card.id));
    expect(calls[0].options.baseSha).toBe("abc123def456");
  });

  it("moves Plan to needs-user with a failed run when the agent errors", async () => {
    const card = queuedCard();
    const { engine } = makeEngine([{ error: new Error("sdk exploded") }]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(card.id, "plan")).toBe("needs-user");
    const run = runStore.latestForStep(card.id, "plan");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("sdk exploded");
  });

  it("treats a cancelled run as failed", async () => {
    const card = queuedCard();
    const { engine } = makeEngine([
      {
        events: [
          { type: "log", line: "working…" },
          { type: "result", status: "cancelled" },
        ],
      },
    ]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(card.id, "plan")).toBe("needs-user");
    const run = runStore.latestForStep(card.id, "plan");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/cancel/i);
  });

  it("runs one card at a time — second stays queued until the first finishes", async () => {
    const first = queuedCard("First");
    const second = queuedCard("Second");
    let release!: (events: RunEvent[]) => void;
    const gate = new Promise<RunEvent[]>((r) => (release = r));
    const { engine } = makeEngine([{ gate }, { events: ok() }]);

    engine.enqueue(first.id, "plan");
    engine.enqueue(second.id, "plan");
    await tick();

    expect(stepStatus(first.id, "plan")).toBe("ai-working");
    expect(stepStatus(second.id, "plan")).toBe("queued");

    release(ok());
    await engine.whenIdle();

    expect(stepStatus(first.id, "plan")).toBe("done");
    expect(stepStatus(second.id, "plan")).toBe("done");
  });

  it("emits card.updated, run.log, and run.finished to subscribers", async () => {
    const card = queuedCard();
    const { engine } = makeEngine([{ events: ok() }]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    const run = runStore.latestForStep(card.id, "plan")!;
    const types = received.map((e) => e.type);
    expect(types).toEqual([
      "card.updated", // ai-working
      "run.log",
      "run.finished",
      "card.updated", // done
    ]);
    const log = received.find((e) => e.type === "run.log");
    expect(log).toMatchObject({ runId: run.id, cardId: card.id, line: "working…" });
    const finished = received.find((e) => e.type === "run.finished");
    expect(finished).toMatchObject({ runId: run.id, status: "succeeded" });
  });

  describe("boot", () => {
    it("fails orphaned running runs and moves their steps to needs-user", async () => {
      const card = queuedCard();
      // Simulate a crash mid-run: step ai-working, run row still running.
      store.setStepStatus(card.id, "plan", "ai-working");
      const orphan = runStore.create({
        cardId: card.id,
        stepKey: "plan",
        skill: "slice-3-tracer",
        logPath: "x.log",
      });
      const { engine, calls } = makeEngine([]);

      engine.boot();
      await engine.whenIdle();

      expect(runStore.get(orphan.id)?.status).toBe("failed");
      expect(stepStatus(card.id, "plan")).toBe("needs-user");
      expect(calls).toHaveLength(0); // orphan must not be re-enqueued
    });

    it("re-enqueues steps left queued by a restart", async () => {
      const card = queuedCard(); // decideKind left plan queued, nothing consumed it
      const { engine } = makeEngine([{ events: ok() }]);

      engine.boot();
      await engine.whenIdle();

      expect(stepStatus(card.id, "plan")).toBe("done");
    });
  });

  it("stop() aborts the in-flight run, failing it to needs-user", async () => {
    const card = queuedCard();
    const gate = new Promise<RunEvent[]>(() => {}); // never resolves
    const { engine } = makeEngine([{ gate }]);

    engine.enqueue(card.id, "plan");
    await tick();
    expect(stepStatus(card.id, "plan")).toBe("ai-working");

    await engine.stop();

    expect(stepStatus(card.id, "plan")).toBe("needs-user");
    expect(runStore.latestForStep(card.id, "plan")?.status).toBe("failed");
  });

  it("retry re-queues a failed step and starts a fresh run row", async () => {
    const card = queuedCard();
    const { engine } = makeEngine([
      { error: new Error("first attempt died") },
      { events: ok() },
    ]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();
    expect(stepStatus(card.id, "plan")).toBe("needs-user");

    received.length = 0;
    const retried = engine.retry(card.id, "plan");
    expect(retried.steps.find((s) => s.key === "plan")?.status).toBe("queued");
    expect(received[0]).toEqual(
      expect.objectContaining({
        type: "card.updated",
        card: expect.objectContaining({
          id: card.id,
          steps: expect.arrayContaining([
            expect.objectContaining({ key: "plan", status: "queued" }),
          ]),
        }),
      }),
    );
    await engine.whenIdle();

    expect(stepStatus(card.id, "plan")).toBe("done");
    const runsForCard = runStore.listForCard(card.id);
    expect(runsForCard).toHaveLength(2);
    expect(runsForCard.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("rejects retry when the step has no failed run", () => {
    const card = queuedCard();
    const { engine } = makeEngine([]);
    expect(() => engine.retry(card.id, "plan")).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => engine.retry("missing", "plan")).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Rejects when the signal aborts — mirrors how the SDK cancels a run. */
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
