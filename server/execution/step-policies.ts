import path from "node:path";
import type { ArtifactStore, HarvestDeclaration } from "../artifacts/store.js";
import type { CardWithSteps } from "../cards/store.js";
import type { StepKey } from "../pipelines.js";
import { aiReviewPromptVars } from "./ai-review.js";
import { implementPromptVars } from "./implement-task.js";
import { planPromptVars } from "./plan-implementation.js";
import {
  PREPEVAL_STUB_EXCHANGE,
  writePrepareEvalStub,
} from "./prepare-eval-stub.js";
import type { CardAttachmentInput } from "./render-prompt.js";
import type { RunFinalizeContext } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";

/** Commit expectation on the card branch after the step settles. */
export type CommitExpectation = "forbidden" | "required" | "any";

export interface PromptBuildContext {
  card: CardWithSteps;
  planBody: string;
  parentSpec: string;
  manifestPath: string;
  attachments: readonly CardAttachmentInput[];
}

interface StepPolicyBase {
  skill: string;
  commits: CommitExpectation;
  harvest?: HarvestDeclaration[];
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
  /**
   * Checked after the run row exists and before the worktree / agent starts.
   * Throw to fail the step (`needs-user`) without calling the runner.
   */
  precondition?: (
    card: CardWithSteps,
    attachments: readonly CardAttachmentInput[],
  ) => void;
}

export type StepExecutionPolicy =
  | (StepPolicyBase & {
      kind: "agent";
      promptFile: string;
      promptVars: (ctx: PromptBuildContext) => Record<string, string>;
    })
  | (StepPolicyBase & {
      kind: "host";
      hostBody: (ctx: RunFinalizeContext) => Promise<void>;
      /** Run-log / SSE status line while hostBody runs. */
      hostStatusLine?: string;
    });

/** Plan must not start from a title alone. */
export const PLAN_INSUFFICIENT_INPUT =
  "Plan needs a card description or an Info attachment with an instruction. Add either, then retry.";

/** Host gate: description or at least one non-empty attachment instruction. */
export function assertPlanHasEnoughInput(input: {
  description: string;
  attachments: readonly CardAttachmentInput[];
}): void {
  if (input.description.trim()) return;
  if (input.attachments.some((att) => att.instruction.trim())) return;
  throw new Error(PLAN_INSUFFICIENT_INPUT);
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
    kind: "agent",
    skill: "plan-implementation",
    promptFile: path.join("prompts", "execution", "plan-implementation.md"),
    commits: "forbidden",
    promptVars: (ctx) =>
      planPromptVars({
        cardTitle: ctx.card.title,
        cardDescription: ctx.card.description,
        parentSpec: ctx.parentSpec,
        manifestPath: ctx.manifestPath,
        attachments: ctx.attachments,
      }),
    precondition: (card, attachments) =>
      assertPlanHasEnoughInput({
        description: card.description,
        attachments,
      }),
    harvest: [
      {
        exchangePath: ".jeeves/plan.md",
        kind: "plan",
        stepKey: "plan",
        validate: assertExchangeHasUsefulContent,
      },
    ],
    postcondition: (artifacts, cardId, round) =>
      artifacts.latest(cardId, { stepKey: "plan", round, kind: "plan" }) !==
      undefined,
  },
  impl: {
    kind: "agent",
    skill: "implement-task",
    promptFile: path.join("prompts", "execution", "implement-task.md"),
    commits: "required",
    promptVars: (ctx) =>
      implementPromptVars({
        cardTitle: ctx.card.title,
        cardDescription: ctx.card.description,
        plan: ctx.planBody,
        manifestPath: ctx.manifestPath,
        attachments: ctx.attachments,
      }),
    // Empty harvest still runs assertWorkspace (truthy array); Implement outputs are commits.
    harvest: [],
    hostVerify: true,
  },
  airev: {
    kind: "agent",
    skill: "ai-review",
    promptFile: path.join("prompts", "execution", "ai-review.md"),
    commits: "any",
    promptVars: (ctx) =>
      aiReviewPromptVars({
        cardTitle: ctx.card.title,
        cardDescription: ctx.card.description,
        plan: ctx.planBody,
        manifestPath: ctx.manifestPath,
        attachments: ctx.attachments,
      }),
    harvest: [
      {
        exchangePath: ".jeeves/review.md",
        kind: "review",
        stepKey: "airev",
        validate: assertExchangeHasUsefulContent,
      },
    ],
    postcondition: (artifacts, cardId, round) =>
      artifacts.latest(cardId, { stepKey: "airev", round, kind: "review" }) !==
      undefined,
    hostVerify: "if-committed",
  },
  prepeval: {
    kind: "host",
    skill: "eval-assemble",
    commits: "forbidden",
    hostBody: writePrepareEvalStub,
    hostStatusLine: "Preparing interactive evaluation…",
    harvest: [
      {
        exchangePath: PREPEVAL_STUB_EXCHANGE,
        kind: "eval",
        stepKey: "prepeval",
      },
    ],
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

/** Enforce commit expectation + clean tree (ignoring `.jeeves` exchange files). */
export async function assertStepWorkspace(
  policy: StepExecutionPolicy,
  worktrees: WorktreeLifecycle,
  ctx: RunFinalizeContext,
  stepLabel: string,
): Promise<void> {
  if (policy.commits === "forbidden" && ctx.headSha !== ctx.baseSha) {
    throw new Error(`${stepLabel} step must not create commits on the card branch`);
  }
  if (policy.commits === "required" && ctx.headSha === ctx.baseSha) {
    throw new Error(
      `${stepLabel} step must create at least one commit on the card branch`,
    );
  }
  const status = await worktrees.worktreeStatus(ctx.workspacePath, {
    ignorePathPrefixes: [".jeeves"],
  });
  if (status) {
    const summary = status.split("\n")[0] ?? "dirty tree";
    throw new Error(`${stepLabel} step left source tree dirty: ${summary}`);
  }
}
