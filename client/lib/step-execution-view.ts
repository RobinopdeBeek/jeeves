import type { StepStatus } from "./api";

/** How the run-log panel renders for a step's current status. */
export type StepExecutionMode = "queued" | "live" | "frozen";

export function stepExecutionMode(status: StepStatus | undefined): StepExecutionMode {
  if (status === "queued") return "queued";
  if (status === "done" || status === "needs-user") return "frozen";
  if (status === "ai-working") return "live";
  return "live";
}

/** Whether the log panel starts open on first paint. */
export function initialLogOpen(status: StepStatus | undefined): boolean {
  return status === "ai-working";
}

/** After a live run finishes, keep the log open only if the user was watching. */
export function logOpenAfterFinish(wasLive: boolean): boolean {
  return wasLive;
}

/** Frozen mode loads immutable artifacts instead of the live run tail. */
export function usesFrozenArtifacts(mode: StepExecutionMode): boolean {
  return mode === "frozen";
}

/** Markdown overview kinds shown after a successful execution step. */
const MARKDOWN_ARTIFACT_BY_STEP: Record<string, string> = {
  plan: "plan",
  airev: "review",
};

/** Whether to fetch the step's markdown overview artifact (successful runs only). */
export function shouldLoadMarkdownArtifact(
  stepKey: string,
  stepStatus: StepStatus | undefined,
): boolean {
  return stepKey in MARKDOWN_ARTIFACT_BY_STEP && stepStatus === "done";
}

/** Artifact kind to load for a step's frozen markdown overview, if any. */
export function markdownArtifactKind(stepKey: string): string | undefined {
  return MARKDOWN_ARTIFACT_BY_STEP[stepKey];
}

/** Markdown overview is shown only after a successful run — not on failed attempts. */
export function showMarkdownArtifact(
  stepKey: string,
  stepStatus: StepStatus | undefined,
  artifact: unknown,
): boolean {
  return shouldLoadMarkdownArtifact(stepKey, stepStatus) && artifact != null;
}

/** Live empty-state / status line while a step is ai-working. */
export function liveWorkingMessage(stepKey: string): string {
  if (stepKey === "prepeval") return "Preparing interactive evaluation…";
  return "agent is warming up…";
}
