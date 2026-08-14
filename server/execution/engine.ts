import fs from "node:fs";
import path from "node:path";
import type { CardAttachmentStore } from "../attachments/card-library.js";
import { CardStoreError, type CardWithSteps } from "../cards/store.js";
import type { CardStore } from "../cards/store.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { StepKey } from "../pipelines.js";
import { dispatchAdvanceEffects } from "./dispatch-effects.js";
import { EventBus } from "./events.js";
import type { CardAttachmentInput } from "./render-prompt.js";
import { promptsRootFromTemplatePath, renderPrompt } from "./render-prompt.js";
import type { RunStore } from "./run-store.js";
import type { AgentRunner, RunEvent } from "./runner.js";
import type { WorktreeDiagnostics, WorktreeLifecycle } from "./worktree-manager.js";
import { WorktreeManager } from "./worktree-manager.js";
import {
  assertStepWorkspace,
  meetsPostconditions,
  stepPolicy,
  type StepExecutionPolicy,
} from "./step-policies.js";
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

type RunRow = { id: string; cardId: string; logPath: string | null };

/**
 * ExecutionEngine — sequential queue over the AgentRunner seam. One run at
 * a time. Order is derived from CardStore.listQueuedSteps (depth-first), not
 * in-memory insertion order.
 */
export class ExecutionEngine {
  private processing = false;
  private idleResolvers: Array<() => void> = [];
  private readonly abort = new AbortController();

  constructor(private readonly deps: ExecutionEngineDeps) {}

  /**
   * Wake the processor. The card/step must already be `queued` in the store;
   * the next job is always the head of listQueuedSteps (eligible + depth-first).
   * Args are ignored — kept for AdvanceSideEffect enqueue dispatch shape.
   */
  enqueue(_cardId?: string, _stepKey?: StepKey): void {
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
    // One wake drains all eligible steps in durable depth-first order.
    if (store.listQueuedSteps().length > 0) {
      this.enqueue();
    }
  }

  /** Graceful shutdown: cancel the in-flight run and stop picking new work. */
  async stop(): Promise<void> {
    this.abort.abort(new Error("server shutting down"));
    await this.whenIdle();
  }

  /** Resolves once no run is in flight and the processor is idle. */
  whenIdle(): Promise<void> {
    if (!this.processing) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      // After shutdown-abort, leave remaining jobs `queued` in the DB so the
      // next boot re-enqueues them; only the in-flight run is interrupted.
      while (!this.abort.signal.aborted) {
        const next = this.deps.store.listQueuedSteps()[0];
        if (!next) break;
        const claim = `${next.cardId}:${next.stepKey}`;
        await this.execute(next.cardId, next.stepKey);
        const head = this.deps.store.listQueuedSteps()[0];
        // execute must claim the step; otherwise avoid spinning on it.
        if (head && `${head.cardId}:${head.stepKey}` === claim) break;
      }
    } finally {
      this.processing = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  private async execute(cardId: string, stepKey: StepKey): Promise<void> {
    const { store, runs, worktrees, events } = this.deps;
    const policy = stepPolicy(stepKey);
    const card = store.getCard(cardId);
    if (!policy || !card) return;
    // Blocked cards stay queued until merge (slice 10); never start them.
    if (store.hasUnmergedBlockers(cardId)) return;
    const step = card.steps.find((s) => s.key === stepKey);
    if (step?.status !== "queued") return;

    const round = currentRound(cardId);
    const priorRun = runs.latestForStep(cardId, stepKey);
    const branch = card.branch ?? WorktreeManager.cardBranch(cardId);
    const isRetry = priorRun?.status === "failed" && Boolean(priorRun.baseSha);
    const worktreePath = worktrees.worktreePathFor(cardId);
    const repoPath = store.getRepoPath(cardId);

    let headSha: string | undefined;
    let run: RunRow | undefined;
    let logPath = "";

    const fail = async (message: string) => {
      if (!run) return;
      await this.preserveFailureEvidence(
        run,
        stepKey,
        round,
        policy.skill,
        worktreePath,
        headSha,
      );
      runs.finish(run.id, { status: "failed", error: message });
      await this.finishStep(cardId, stepKey, run.id, "failed", message);
    };

    try {
      const decision = await worktrees.resolveRunBase({
        cardBranch: branch,
        hasDurableBranch: Boolean(card.branch) && !isRetry,
        priorFailedBaseSha: isRetry ? priorRun!.baseSha! : null,
        upstreamRef: store.getUpstreamRef(cardId),
      });
      const baseSha = decision.baseSha;

      run = runs.create({
        cardId,
        stepKey,
        skill: policy.skill,
        round,
        logPath: "",
        baseSha,
      });
      logPath = this.deps.artifacts.liveLogPath(cardId, round, run.id);
      runs.setLogPath(run.id, logPath);

      events.emit({
        type: "card.updated",
        card: store.setStepStatus(cardId, stepKey, "ai-working"),
      });

      if (policy.precondition) {
        policy.precondition(store.getCard(cardId) ?? card, this.cardLibraryAttachments(cardId));
      }

      await worktrees.openRunWorkspace(decision, branch, worktreePath);

      if (!card.branch) {
        store.setCardBranch(cardId, branch);
      }

      const settleCtx = {
        run,
        cardId,
        stepKey,
        round,
        skill: policy.skill,
        policy,
        baseSha,
        worktreePath,
        logPath,
        fail,
      };

      if (policy.kind === "host") {
        await this.runHostBody(policy, settleCtx, (sha) => {
          headSha = sha;
        });
      } else {
        await this.runAgentBody(policy, card, settleCtx, repoPath, branch, (sha) => {
          headSha = sha;
        });
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

  private async runHostBody(
    policy: Extract<StepExecutionPolicy, { kind: "host" }>,
    settleCtx: SettleContext,
    setHeadSha: (sha: string) => void,
  ): Promise<void> {
    const { worktrees } = this.deps;
    const { worktreePath, baseSha, logPath, run, cardId } = settleCtx;
    const line = policy.hostStatusLine ?? "Host step running…";
    try {
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // Best-effort — UI still gets the SSE line.
    }
    this.deps.events.emit({ type: "run.log", runId: run.id, cardId, line });

    const tipBefore = baseSha;
    await policy.hostBody({
      workspacePath: worktreePath,
      headSha: tipBefore,
      baseSha,
    });
    // Re-resolve tip so "no commits" is checked against the real worktree.
    const branch = this.deps.store.getCard(cardId)?.branch;
    const headSha = branch
      ? await worktrees.resolveRef(branch)
      : tipBefore;
    setHeadSha(headSha);
    await this.finalizeStep(settleCtx.cardId, settleCtx.stepKey, settleCtx.round, settleCtx.skill, {
      workspacePath: worktreePath,
      headSha,
      baseSha: tipBefore,
    });
    await this.settle(settleCtx, { headSha, committed: headSha !== tipBefore });
  }

  private async runAgentBody(
    policy: Extract<StepExecutionPolicy, { kind: "agent" }>,
    card: CardWithSteps,
    settleCtx: SettleContext,
    repoPath: string,
    branch: string,
    setHeadSha: (sha: string) => void,
  ): Promise<void> {
    const { runner } = this.deps;
    const { worktreePath, baseSha, logPath, cardId, stepKey, round, skill } =
      settleCtx;

    let result: Extract<RunEvent, { type: "result" }> | undefined;
    let headSha: string | undefined;
    const prompt = this.buildPrompt(card, policy);
    const iterable = runner.run(prompt, {
      cwd: repoPath,
      branch,
      worktreePath,
      baseSha,
      logPath,
      signal: this.abort.signal,
      onFinalize: async (ctx) => {
        headSha = ctx.headSha;
        setHeadSha(ctx.headSha);
        await this.finalizeStep(cardId, stepKey, round, skill, ctx);
      },
    });
    for await (const event of iterable) {
      if (event.type === "log") {
        this.deps.events.emit({
          type: "run.log",
          runId: settleCtx.run.id,
          cardId,
          line: event.line,
        });
      } else {
        result = event;
      }
    }

    if (result?.status === "cancelled") {
      await settleCtx.fail("run cancelled");
      return;
    }
    if (result?.status !== "finished") {
      await settleCtx.fail("step postconditions not met");
      return;
    }

    await this.settle(settleCtx, {
      headSha,
      committed: headSha !== undefined && headSha !== baseSha,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    });
  }

  /**
   * Shared success path: postconditions → host verify → freeze → finish.
   * Host and agent bodies both land here after finalize.
   */
  private async settle(
    ctx: SettleContext,
    outcome: {
      headSha?: string;
      committed: boolean;
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
    },
  ): Promise<void> {
    const { artifacts, runs } = this.deps;
    if (!meetsPostconditions(ctx.stepKey, artifacts, ctx.cardId, ctx.round)) {
      await ctx.fail("step postconditions not met");
      return;
    }

    const verify = await this.runHostVerifyIfNeeded(
      ctx.run.id,
      ctx.cardId,
      ctx.policy,
      ctx.worktreePath,
      ctx.logPath,
      outcome.committed,
    );
    if (verify.status === "failed") {
      await ctx.fail(verify.message);
      return;
    }

    this.freezeRunLog(
      ctx.run,
      ctx.stepKey,
      ctx.round,
      ctx.skill,
      outcome.headSha,
    );
    runs.finish(ctx.run.id, {
      status: "succeeded",
      model: outcome.model,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
    });
    await this.finishStep(ctx.cardId, ctx.stepKey, ctx.run.id, "succeeded");
  }

  private freezeRunLog(
    run: RunRow,
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
    await assertStepWorkspace(
      policy,
      this.deps.worktrees,
      ctx,
      stepKey === "impl"
        ? "implement"
        : stepKey === "airev"
          ? "ai-review"
          : stepKey === "prepeval"
            ? "prepare-eval"
            : stepKey,
    );
    this.deps.artifacts.harvest(ctx.workspacePath, policy.harvest, {
      cardId,
      round,
      sourceSkill,
      gitSha: ctx.headSha,
    });
  }

  private async preserveFailureEvidence(
    run: RunRow,
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

  private async finishStep(
    cardId: string,
    stepKey: StepKey,
    runId: string,
    runStatus: "succeeded" | "failed",
    error?: string,
  ): Promise<void> {
    const { store, events } = this.deps;
    const outcome = runStatus === "succeeded" ? "succeeded" : "failed";
    const { card, sideEffects } = store.applyStepFinished(
      cardId,
      stepKey,
      outcome,
    );
    events.emit({ type: "run.finished", runId, cardId, status: runStatus, error });
    events.emit({ type: "card.updated", card });
    await dispatchAdvanceEffects(cardId, sideEffects, {
      enqueue: (id, key) => this.enqueue(id, key),
      ensureBranch: (id) => this.ensureBranch(id),
    });
  }

  /** Compose the fully injected prompt for an agent step. */
  private buildPrompt(
    card: CardWithSteps,
    policy: Extract<StepExecutionPolicy, { kind: "agent" }>,
  ): string {
    const { artifacts, repoRoot } = this.deps;
    const templatePath = path.resolve(repoRoot, policy.promptFile);
    const template = fs.readFileSync(templatePath, "utf8");
    return renderPrompt(
      template,
      policy.promptVars({
        card,
        planBody: this.planArtifactBody(card.id),
        parentSpec: this.parentSpecBody(card),
        manifestPath: artifacts.manifestAbsolutePath(card.id),
        attachments: this.cardLibraryAttachments(card.id),
      }),
      { promptsRoot: promptsRootFromTemplatePath(templatePath) },
    );
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

  private cardLibraryAttachments(cardId: string): CardAttachmentInput[] {
    const library = this.deps.cardAttachments;
    if (!library) return [];
    const out: CardAttachmentInput[] = [];
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
   * Host gate after a successful finalize when the step policy opts in.
   * Null/empty `projects.verify_commands` skips with a warning on the run log.
   * `"if-committed"` skips entirely when the step made no commits.
   */
  private async runHostVerifyIfNeeded(
    runId: string,
    cardId: string,
    policy: StepExecutionPolicy,
    worktreePath: string,
    logPath: string,
    committed: boolean,
  ): Promise<{ status: "passed" | "skipped" } | { status: "failed"; message: string }> {
    if (!policy.hostVerify) return { status: "skipped" };
    if (policy.hostVerify === "if-committed" && !committed) {
      return { status: "skipped" };
    }

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

interface SettleContext {
  run: RunRow;
  cardId: string;
  stepKey: StepKey;
  round: number;
  skill: string;
  policy: StepExecutionPolicy;
  baseSha: string;
  worktreePath: string;
  logPath: string;
  fail: (message: string) => Promise<void>;
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
