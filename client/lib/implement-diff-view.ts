import type { StepStatus } from "./api";

/** Soft total-line threshold before asking the user to confirm loading patches. */
export const IMPLEMENT_DIFF_SOFT_LINE_LIMIT = 3000;

/** Implement tab shows the live three-dot DiffViewer only after a successful run. */
export function shouldShowImplementDiff(
  stepKey: string,
  stepStatus: StepStatus | undefined,
): boolean {
  return stepKey === "impl" && stepStatus === "done";
}

/** Whether the summary's changed-line total warrants a soft Load-anyway gate. */
export function diffNeedsLoadConfirmation(
  totalAdditions: number,
  totalDeletions: number,
  limit: number = IMPLEMENT_DIFF_SOFT_LINE_LIMIT,
): boolean {
  return totalAdditions + totalDeletions > limit;
}

/** Short SHA for attribution labels. */
export function shortSha(sha: string, length = 7): string {
  return sha.slice(0, length);
}
