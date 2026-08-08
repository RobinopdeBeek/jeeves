import path from "node:path";
import type { ArtifactStore, HarvestDeclaration } from "../artifacts/store.js";
import type { StepKey } from "../pipelines.js";
import {
  PREPEVAL_STUB_EXCHANGE,
  writePrepareEvalStub,
} from "./prepare-eval-stub.js";
import type { RunFinalizeContext } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";

export interface StepExecutionPolicy {
  skill: string;
  /**
   * Skill prompt under the app repo. Required for agent-run steps; unused when
   * `hostBody` is set (Prepare Eval stub).
   */
  promptFile?: string;
  /**
   * Host-owned step body — skips AgentRunner. Used for the Prepare Eval stub
   * until slice 9 wires real eval-assemble.
   */
  hostBody?: (ctx: RunFinalizeContext) => Promise<void>;
  /** Run-log / SSE status line while `hostBody` runs (Prepare Eval stub). */
  hostStatusLine?: string;
  harvest?: HarvestDeclaration[];
  assertWorkspace?: (
    worktrees: WorktreeLifecycle,
    ctx: RunFinalizeContext,
  ) => Promise<void>;
  postcondition?: (
    artifacts: ArtifactStore,
    cardId: string,
    round: number,
  ) => boolean;
  /**
   * Host `projects.verify_commands` after a successful finalize.
   * `true` always; `"if-committed"` only when headSha !== baseSha.
   */
  hostVerify?: boolean | "if-committed";
}

/** Exchange markdown needs prose beyond headings and empty bullets. */
export function assertExchangeHasUsefulContent(raw: string): void {
  const body = stripFrontmatter(raw)
    .replace(/^#+\s+.*$/gm, "")
    .replace(/^[-*]\s*$/gm, "")
    .trim();
  if (body.length === 0) {
    throw new Error("exchange file has no useful content");
  }
}

/** @deprecated Prefer assertExchangeHasUsefulContent. */
export const assertPlanHasUsefulContent = assertExchangeHasUsefulContent;

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}

export const STEP_POLICIES: Partial<Record<StepKey, StepExecutionPolicy>> = {
  plan: {
    skill: "plan-implementation",
    promptFile: path.join("prompts", "execution", "plan-implementation.md"),
    harvest: [
      {
        exchangePath: ".jeeves/plan.md",
        kind: "plan",
        stepKey: "plan",
        validate: assertExchangeHasUsefulContent,
      },
    ],
    assertWorkspace: assertPlanWorkspaceClean,
    postcondition: (artifacts, cardId, round) =>
      artifacts.latest(cardId, { stepKey: "plan", round, kind: "plan" }) !== undefined,
  },
  impl: {
    skill: "implement-task",
    promptFile: path.join("prompts", "execution", "implement-task.md"),
    // Empty harvest still runs assertWorkspace (truthy array); Implement outputs are commits.
    harvest: [],
    assertWorkspace: assertImplementWorkspace,
    hostVerify: true,
  },
  airev: {
    skill: "ai-review",
    promptFile: path.join("prompts", "execution", "ai-review.md"),
    harvest: [
      {
        exchangePath: ".jeeves/review.md",
        kind: "review",
        stepKey: "airev",
        validate: assertExchangeHasUsefulContent,
      },
    ],
    assertWorkspace: assertAiReviewWorkspace,
    postcondition: (artifacts, cardId, round) =>
      artifacts.latest(cardId, { stepKey: "airev", round, kind: "review" }) !==
      undefined,
    hostVerify: "if-committed",
  },
  prepeval: {
    skill: "eval-assemble",
    hostBody: writePrepareEvalStub,
    hostStatusLine: "Preparing interactive evaluation…",
    harvest: [
      {
        exchangePath: PREPEVAL_STUB_EXCHANGE,
        kind: "eval",
        stepKey: "prepeval",
      },
    ],
    assertWorkspace: assertPrepareEvalWorkspace,
    postcondition: (artifacts, cardId, round) =>
      artifacts.latest(cardId, { stepKey: "prepeval", round, kind: "eval" }) !==
      undefined,
  },
};

export function stepPolicy(stepKey: StepKey): StepExecutionPolicy | undefined {
  return STEP_POLICIES[stepKey];
}

export function meetsPostconditions(
  stepKey: StepKey,
  artifacts: ArtifactStore,
  cardId: string,
  round: number,
): boolean {
  const check = STEP_POLICIES[stepKey]?.postcondition;
  return check ? check(artifacts, cardId, round) : true;
}

/** Plan runs must leave the target tree unchanged after exchange files are removed. */
async function assertPlanWorkspaceClean(
  worktrees: WorktreeLifecycle,
  ctx: RunFinalizeContext,
): Promise<void> {
  if (ctx.headSha !== ctx.baseSha) {
    throw new Error("plan step must not create commits on the card branch");
  }
  await assertTreeCleanIgnoringJeeves(worktrees, ctx, "plan");
}

/** Implement must leave ≥1 commit and a clean tree after exchange cleanup. */
async function assertImplementWorkspace(
  worktrees: WorktreeLifecycle,
  ctx: RunFinalizeContext,
): Promise<void> {
  if (ctx.headSha === ctx.baseSha) {
    throw new Error("implement step must create at least one commit on the card branch");
  }
  await assertTreeCleanIgnoringJeeves(worktrees, ctx, "implement");
}

/**
 * AI Review: review artifact harvested separately; zero or more commits OK;
 * tree must be clean after exchange removal.
 */
async function assertAiReviewWorkspace(
  worktrees: WorktreeLifecycle,
  ctx: RunFinalizeContext,
): Promise<void> {
  await assertTreeCleanIgnoringJeeves(worktrees, ctx, "ai-review");
}

/** Prepare Eval: placeholder eval only; no source commits; clean tree. */
async function assertPrepareEvalWorkspace(
  worktrees: WorktreeLifecycle,
  ctx: RunFinalizeContext,
): Promise<void> {
  if (ctx.headSha !== ctx.baseSha) {
    throw new Error("prepare-eval step must not create commits on the card branch");
  }
  await assertTreeCleanIgnoringJeeves(worktrees, ctx, "prepare-eval");
}

async function assertTreeCleanIgnoringJeeves(
  worktrees: WorktreeLifecycle,
  ctx: RunFinalizeContext,
  stepLabel: string,
): Promise<void> {
  const status = await worktrees.worktreeStatus(ctx.workspacePath, {
    ignorePathPrefixes: [".jeeves"],
  });
  if (status) {
    const summary = status.split("\n")[0] ?? "dirty tree";
    throw new Error(`${stepLabel} step left source tree dirty: ${summary}`);
  }
}
