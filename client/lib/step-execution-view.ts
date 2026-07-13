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
