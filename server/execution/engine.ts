import fs from "node:fs";
import path from "node:path";
import type { CardAttachmentStore } from "../attachments/card-library.js";
import { CardStoreError, type CardWithSteps } from "../cards/store.js";
import type { CardStore } from "../cards/store.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { StepKey } from "../pipelines.js";
import { EventBus } from "./events.js";
import {
  buildImplementTaskPrompt,
  type ImplementAttachmentInput,
} from "./implement-task.js";
import { buildPlanImplementationPrompt } from "./plan-implementation.js";
import type { RunStore } from "./run-store.js";
import type { AgentRunner, RunEvent } from "./runner.js";
import type { WorktreeDiagnostics, WorktreeLifecycle } from "./worktree-manager.js";
import { WorktreeManager } from "./worktree-manager.js";
import { meetsPostconditions, stepPolicy } from "./step-policies.js";
import { parseVerifyCommands, runVerifyCommands } from "./verify-commands.js";

export interface ExecutionEngineDeps {
  store: CardStore;
  runs: RunStore;
  runner: AgentRunner;
  worktrees: WorktreeLifecycle;
  artifacts: ArtifactStore;
  events: EventBus;
  /** Repo root — prompt templates resolve relative to this. */
  repoRoot: string;
  /** Card Info library — Plan/Implement/AI Review inject on-disk paths. */
  cardAttachments?: CardAttachmentStore;
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
   * Create the durable card branch from its upstream tip and persist
   * `cards.branch`. No-op when already recorded. Used at feature fan-out.
   */
  async ensureBranch(cardId: string): Promise<void> {
    const { store, worktrees, events } = this.deps;
    const card = store.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    if (card.branch) return;

    const branch = WorktreeManager.cardBranch(cardId);
    const upstream = store.getUpstreamRef(cardId);
    const baseSha = await worktrees.resolveRef(upstream);
    await worktrees.ensureBranch(branch, baseSha);
    events.emit({
      type: "card.updated",
      card: store.setCardBranch(cardId, branch),
    });
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
    const orphans = runs.listRunning();
    for (const orphan of orphans) {
      this.freezeRunLog(
        orphan,
        orphan.stepKey as StepKey,
        orphan.round,
        orphan.skill,
      );
      runs.finish(orphan.id, {
        status: "failed",
        error: "interrupted by server restart",
      });
      events.emit({
        type: "card.updated",
        card: store.setStepStatus(orphan.cardId, orphan.stepKey as StepKey, "needs-user"),
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
    const { store, runs, runner, worktrees, artifacts, events } = this.deps;
    const policy = stepPolicy(stepKey);
    const card = store.getCard(cardId);
    if (!policy || !card) return;

    const round = currentRound(cardId);
    const priorRun = runs.latestForStep(cardId, stepKey);
    const branch = card.branch ?? WorktreeManager.cardBranch(cardId);
    const isRetry = priorRun?.status === "failed" && Boolean(priorRun.baseSha);
    const isContinuation = Boolean(card.branch) && !isRetry;

    let baseSha: string;
    if (isRetry) {
      baseSha = priorRun!.baseSha!;
    } else if (isContinuation) {
      // Record tip-at-start so a later retry of this run can recreate cleanly.
      baseSha = await worktrees.resolveRef(branch);
    } else {
      baseSha = await worktrees.resolveRef(store.getUpstreamRef(cardId));
    }

    const run = runs.create({
      cardId,
      stepKey,
      skill: policy.skill,
      round,
      logPath: "",
      baseSha,
    });
    const logPath = artifacts.liveLogPath(cardId, round, run.id);
    runs.setLogPath(run.id, logPath);

    events.emit({
      type: "card.updated",
      card: store.setStepStatus(cardId, stepKey, "ai-working"),
    });

    const repoPath = store.getRepoPath(cardId);
    const worktreePath = worktrees.worktreePathFor(cardId);
    let headSha: string | undefined;

    const fail = async (message: string) => {
      await this.preserveFailureEvidence(
        run,
        stepKey,
        round,
        policy.skill,
        worktreePath,
        headSha,
      );
      runs.finish(run.id, { status: "failed", error: message });
      this.finishStep(cardId, stepKey, run.id, "failed", message);
    };

    try {
      if (isContinuation) {
        await worktrees.checkoutExisting(branch, worktreePath);
      } else {
        await worktrees.createFrom(branch, baseSha, worktreePath);
      }
      if (!card.branch) {
        store.setCardBranch(cardId, branch);
      }

      let result: Extract<RunEvent, { type: "result" }> | undefined;
      const prompt = this.buildPrompt(card, stepKey, policy.promptFile);
      const iterable = runner.run(prompt, {
        cwd: repoPath,
        branch,
        worktreePath,
        baseSha,
        logPath,
        signal: this.abort.signal,
        onFinalize: async (ctx) => {
          headSha = ctx.headSha;
          await this.finalizeStep(cardId, stepKey, round, policy.skill, ctx);
        },
      });
      for await (const event of iterable) {
        if (event.type === "log") {
          events.emit({ type: "run.log", runId: run.id, cardId, line: event.line });
        } else {
          result = event;
        }
      }
      if (
        result?.status === "finished" &&
        meetsPostconditions(stepKey, artifacts, cardId, round)
      ) {
        const verify = await this.runHostVerifyIfNeeded(
          run.id,
          cardId,
          stepKey,
          worktreePath,
          logPath,
        );
        if (verify.status === "failed") {
          await fail(verify.message);
        } else {
          this.freezeRunLog(run, stepKey, round, policy.skill, headSha);
          runs.finish(run.id, {
            status: "succeeded",
            model: result.model,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
          });
          this.finishStep(cardId, stepKey, run.id, "succeeded");
        }
      } else if (result?.status === "cancelled") {
        await fail("run cancelled");
      } else {
        await fail("step postconditions not met");
      }
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        await worktrees.remove(worktreePath);
      } catch {
        // Non-fatal: orphan cleanup runs on next boot.
      }
    }
  }

  private freezeRunLog(
    run: { id: string; cardId: string; logPath: string | null },
    stepKey: StepKey,
    round: number,
    sourceSkill: string,
    gitSha?: string,
  ): void {
    const row = this.deps.runs.get(run.id);
    const logPath = row?.logPath;
    if (!logPath) return;
    let content = "";
    try {
      if (fs.existsSync(logPath)) {
        content = fs.readFileSync(logPath, "utf8");
      }
    } catch {
      // Degraded freeze — still index an empty runlog so the UI does not lie.
    }
    this.deps.artifacts.save({
      cardId: run.cardId,
      stepKey,
      round,
      kind: "runlog",
      content,
      sourceSkill,
      gitSha,
    });
  }

  private async finalizeStep(
    cardId: string,
    stepKey: StepKey,
    round: number,
    sourceSkill: string,
    ctx: { workspacePath: string; headSha: string; baseSha: string },
  ): Promise<void> {
    const policy = stepPolicy(stepKey);
    if (!policy?.harvest) return;
    if (policy.assertWorkspace) {
      await policy.assertWorkspace(this.deps.worktrees, ctx);
    }
    this.deps.artifacts.harvest(ctx.workspacePath, policy.harvest, {
      cardId,
      round,
      sourceSkill,
      gitSha: ctx.headSha,
    });
  }

  private async preserveFailureEvidence(
    run: { id: string; cardId: string; logPath: string | null },
    stepKey: StepKey,
    round: number,
    sourceSkill: string,
    worktreePath: string,
    gitSha?: string,
  ): Promise<void> {
    this.freezeRunLog(run, stepKey, round, sourceSkill, gitSha);
    if (!worktreePath || !fs.existsSync(worktreePath)) return;
    try {
      const diag = await this.deps.worktrees.captureDiagnostics(worktreePath);
      this.deps.artifacts.save({
        cardId: run.cardId,
        stepKey,
        round,
        kind: "attachment",
        content: formatWorkspaceDiagnostics(diag),
        sourceSkill,
        gitSha: gitSha ?? diag.headSha,
      });
    } catch {
      // Best-effort — run log is the minimum retained evidence.
    }
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
    runId: string,
    runStatus: "succeeded" | "failed",
    error?: string,
  ): void {
    const { store, events } = this.deps;
    const outcome = runStatus === "succeeded" ? "succeeded" : "failed";
    const { card, sideEffects } = store.applyStepFinished(
      cardId,
      stepKey,
      outcome,
    );
    events.emit({ type: "run.finished", runId, cardId, status: runStatus, error });
    events.emit({ type: "card.updated", card });
    for (const effect of sideEffects) {
      if (effect.type === "enqueue") {
        this.enqueue(effect.cardId, effect.stepKey);
      }
    }
  }

  /** Compose the fully injected prompt for a step (skills never hunt the DB). */
  private buildPrompt(
    card: CardWithSteps,
    stepKey: StepKey,
    promptFile: string,
  ): string {
    const { artifacts, repoRoot } = this.deps;
    const templatePath = path.resolve(repoRoot, promptFile);

    if (stepKey === "plan") {
      return buildPlanImplementationPrompt(
        {
          cardTitle: card.title,
          cardDescription: card.description,
          parentSpec: this.parentSpecBody(card),
          manifestPath: artifacts.manifestAbsolutePath(card.id),
          attachments: this.cardLibraryAttachments(card.id),
        },
        templatePath,
      );
    }

    if (stepKey === "impl") {
      return buildImplementTaskPrompt(
        {
          cardTitle: card.title,
          cardDescription: card.description,
          plan: this.planArtifactBody(card.id),
          manifestPath: artifacts.manifestAbsolutePath(card.id),
          attachments: this.cardLibraryAttachments(card.id),
        },
        templatePath,
      );
    }

    return fs.readFileSync(templatePath, "utf8");
  }

  private planArtifactBody(cardId: string): string {
    const { artifacts } = this.deps;
    const plan = artifacts.latest(cardId, {
      stepKey: "plan",
      round: currentRound(cardId),
      kind: "plan",
    });
    return plan ? artifacts.readBody(plan) : "";
  }

  private parentSpecBody(card: CardWithSteps): string {
    if (!card.parentCardId) return "";
    const { artifacts } = this.deps;
    const spec = artifacts.latest(card.parentCardId, {
      stepKey: "spec",
      round: 0,
      kind: "spec",
    });
    return spec ? artifacts.readBody(spec) : "";
  }

  private cardLibraryAttachments(cardId: string): ImplementAttachmentInput[] {
    const library = this.deps.cardAttachments;
    if (!library) return [];
    const out: ImplementAttachmentInput[] = [];
    for (const att of library.list(cardId)) {
      const absolutePath = library.absolutePath(cardId, att.id);
      if (!absolutePath) continue;
      out.push({
        absolutePath,
        filename: att.filename,
        instruction: att.instruction,
      });
    }
    return out;
  }

  /**
   * Host gate after a successful agent finalize when the step policy opts in.
   * Null/empty `projects.verify_commands` skips with a warning on the run log.
   */
  private async runHostVerifyIfNeeded(
    runId: string,
    cardId: string,
    stepKey: StepKey,
    worktreePath: string,
    logPath: string,
  ): Promise<{ status: "passed" | "skipped" } | { status: "failed"; message: string }> {
    const policy = stepPolicy(stepKey);
    if (!policy?.hostVerify) return { status: "skipped" };

    const appendLog = (line: string) => {
      try {
        fs.appendFileSync(logPath, `${line}\n`);
      } catch {
        // Best-effort — failure evidence still carries the Error message.
      }
      this.deps.events.emit({
        type: "run.log",
        runId,
        cardId,
        line,
      });
    };

    let commands: string[] | null;
    try {
      commands = parseVerifyCommands(this.deps.store.getVerifyCommandsRaw(cardId));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      appendLog(message);
      return { status: "failed", message };
    }

    const result = await runVerifyCommands({
      commands,
      cwd: worktreePath,
      log: appendLog,
    });
    if (result.status === "failed") {
      return { status: "failed", message: result.message };
    }
    return { status: result.status === "passed" ? "passed" : "skipped" };
  }
}

/** Slice 8 stays on round 0; task rework rounds land in slice 12. */
function currentRound(_cardId: string): number {
  return 0;
}

function formatWorkspaceDiagnostics(diag: WorktreeDiagnostics): string {
  return [
    "# Workspace diagnostics",
    "",
    "## HEAD",
    diag.headSha,
    "",
    "## Status",
    diag.status || "(clean)",
    "",
    "## Diff",
    "```diff",
    diag.diff || "(empty)",
    "```",
    "",
    "## Staged diff",
    "```diff",
    diag.diffCached || "(empty)",
    "```",
    "",
  ].join("\n");
}
