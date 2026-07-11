import fs from "node:fs";
import path from "node:path";
import { CardStoreError, type CardWithSteps } from "../cards/store.js";
import type { CardStore } from "../cards/store.js";
import type { StepKey } from "../pipelines.js";
import { EventBus } from "./events.js";
import type { RunStore } from "./run-store.js";
import type { AgentRunner, RunEvent } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";
import { WorktreeManager } from "./worktree-manager.js";

/** Which skill an ai-execution step runs (slice 3: Plan → tracer only). */
const STEP_SKILLS: Partial<Record<StepKey, { skill: string; promptFile: string }>> = {
  plan: {
    skill: "slice-3-tracer",
    promptFile: path.join("prompts", "execution", "slice-3-tracer.md"),
  },
};

const DEFAULT_BASE_REF = "main";

export interface ExecutionEngineDeps {
  store: CardStore;
  runs: RunStore;
  runner: AgentRunner;
  worktrees: WorktreeLifecycle;
  events: EventBus;
  /** The artifact folder root — run logs land under `cards/<id>/<round>/`. */
  artifactRoot: string;
  /** Repo root — prompt files resolve relative to this. */
  repoRoot: string;
}

/**
 * ExecutionEngine — sequential FIFO queue over the AgentRunner seam. One
 * run at a time; step transitions, run rows, and SSE events happen here.
 */
export class ExecutionEngine {
  private readonly queue: Array<{ cardId: string; stepKey: StepKey }> = [];
  private processing = false;
  private idleResolvers: Array<() => void> = [];
  private readonly abort = new AbortController();

  constructor(private readonly deps: ExecutionEngineDeps) {}

  enqueue(cardId: string, stepKey: StepKey): void {
    this.queue.push({ cardId, stepKey });
    void this.processQueue();
  }

  /**
   * Boot hooks, in order: (1) orphaned `running` runs from a previous
   * process are failed and their steps parked at needs-user; (2) steps left
   * `queued` (never picked up, or restart before start) are re-enqueued;
   * (3) stale worktree directories are cleaned up.
   */
  boot(): void {
    const { store, runs, events, worktrees } = this.deps;
    void worktrees.cleanupOrphans();
    for (const orphan of runs.failOrphans()) {
      events.emit({
        type: "card.updated",
        card: store.setStepStatus(orphan.cardId, orphan.stepKey, "needs-user"),
      });
    }
    for (const step of store.listQueuedSteps()) {
      this.enqueue(step.cardId, step.stepKey);
    }
  }

  /** Graceful shutdown: cancel the in-flight run and drain the queue. */
  async stop(): Promise<void> {
    this.abort.abort(new Error("server shutting down"));
    await this.whenIdle();
  }

  /** Resolves once the queue is empty and no run is in flight. */
  whenIdle(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      // After shutdown-abort, leave remaining jobs `queued` in the DB so the
      // next boot re-enqueues them; only the in-flight run is interrupted.
      while (!this.abort.signal.aborted) {
        const job = this.queue.shift();
        if (!job) break;
        await this.execute(job.cardId, job.stepKey);
      }
    } finally {
      this.processing = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  private async execute(cardId: string, stepKey: StepKey): Promise<void> {
    const { store, runs, runner, worktrees, events, artifactRoot, repoRoot } =
      this.deps;
    const skill = STEP_SKILLS[stepKey];
    const card = store.getCard(cardId);
    if (!skill || !card) return;

    const round = 0;
    const logDir = path.join(artifactRoot, "cards", cardId, String(round));
    fs.mkdirSync(logDir, { recursive: true });

    const run = runs.create({
      cardId,
      stepKey,
      skill: skill.skill,
      round,
      logPath: "",
    });
    const logPath = path.join(logDir, `run-${run.id}.log`);
    runs.setLogPath(run.id, logPath);

    events.emit({
      type: "card.updated",
      card: store.setStepStatus(cardId, stepKey, "ai-working"),
    });

    const repoPath = store.getRepoPath(cardId);
    const branch = WorktreeManager.cardBranch(cardId);
    const worktreePath = worktrees.worktreePathFor(cardId);
    let baseSha = "";

    const fail = (message: string) => {
      runs.finish(run.id, { status: "failed", error: message });
      this.finishStep(cardId, stepKey, "needs-user", run.id, "failed", message);
    };

    try {
      baseSha = await worktrees.resolveRef(DEFAULT_BASE_REF);
      await worktrees.create(branch, baseSha, worktreePath);

      let result: Extract<RunEvent, { type: "result" }> | undefined;
      const iterable = runner.run(path.resolve(repoRoot, skill.promptFile), {
        cwd: repoPath,
        branch,
        worktreePath,
        baseSha,
        logPath,
        signal: this.abort.signal,
        onFinalize: async (ctx) => {
          await this.finalizeStep(cardId, stepKey, ctx);
        },
      });
      for await (const event of iterable) {
        if (event.type === "log") {
          events.emit({ type: "run.log", runId: run.id, cardId, line: event.line });
        } else {
          result = event;
        }
      }
      if (result?.status === "finished" && checkStepPostconditions(stepKey, result)) {
        runs.finish(run.id, {
          status: "succeeded",
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        });
        this.finishStep(cardId, stepKey, "done", run.id, "succeeded");
      } else if (result?.status === "cancelled") {
        fail("run cancelled");
      } else {
        fail("step postconditions not met");
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        await worktrees.remove(worktreePath);
      } catch {
        // Non-fatal: orphan cleanup runs on next boot.
      }
    }
  }

  /**
   * Post-run finalization on the host worktree path (slice 4: harvest
   * exchange sidecars via ArtifactStore).
   */
  private async finalizeStep(
    _cardId: string,
    _stepKey: StepKey,
    _ctx: { workspacePath: string; headSha: string; baseSha: string },
  ): Promise<void> {
    // slice 4 — ArtifactStore.harvest from workspacePath
  }

  /**
   * Retry a failed (or interruption-orphaned) step: back to `queued`, then
   * onto the queue. Throws CardStoreError 404/409 like the store does —
   * transition rules live here, not in the route (ADR 0006).
   */
  retry(cardId: string, stepKey: StepKey): CardWithSteps {
    const { store, runs } = this.deps;
    const card = store.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");

    const step = card.steps.find((s) => s.key === stepKey);
    const latestRun = runs.latestForStep(cardId, stepKey);
    if (step?.status !== "needs-user" || latestRun?.status !== "failed") {
      throw new CardStoreError(409, "step has no failed run to retry");
    }

    const updated = store.setStepStatus(cardId, stepKey, "queued");
    this.deps.events.emit({ type: "card.updated", card: updated });
    this.enqueue(cardId, stepKey);
    return updated;
  }

  private finishStep(
    cardId: string,
    stepKey: StepKey,
    stepStatus: "done" | "needs-user",
    runId: string,
    runStatus: "succeeded" | "failed",
    error?: string,
  ): void {
    const { store, events } = this.deps;
    events.emit({ type: "run.finished", runId, cardId, status: runStatus, error });
    events.emit({
      type: "card.updated",
      card: store.setStepStatus(cardId, stepKey, stepStatus),
    });
  }
}

/** Slice 4 — per-step success checks beyond runner terminal status. */
function checkStepPostconditions(
  _stepKey: StepKey,
  _result: Extract<RunEvent, { type: "result" }>,
): boolean {
  return true;
}
