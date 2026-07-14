import path from "node:path";
import type { ArtifactStore, HarvestDeclaration } from "../artifacts/store.js";
import type { StepKey } from "../pipelines.js";
import type { RunFinalizeContext } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";

export interface StepExecutionPolicy {
  skill: string;
  promptFile: string;
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
}

export const STEP_POLICIES: Partial<Record<StepKey, StepExecutionPolicy>> = {
  plan: {
    skill: "slice-3-tracer",
    promptFile: path.join("prompts", "execution", "slice-3-tracer.md"),
    harvest: [{ exchangePath: ".jeeves/plan.md", kind: "plan", stepKey: "plan" }],
    assertWorkspace: assertPlanWorkspaceClean,
    postcondition: (artifacts, cardId, round) =>
      artifacts.latest(cardId, { stepKey: "plan", round, kind: "plan" }) !== undefined,
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
  const status = await worktrees.worktreeStatus(ctx.workspacePath, {
    ignorePathPrefixes: [".jeeves"],
  });
  if (status) {
    const summary = status.split("\n")[0] ?? "dirty tree";
    throw new Error(`plan step left source tree dirty: ${summary}`);
  }
}
