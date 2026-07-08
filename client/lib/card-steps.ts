import type { CardStep } from "./api";

/** Work steps = everything except the always-present Info tab. */
export function workSteps(steps: CardStep[]): CardStep[] {
  return steps.filter((s) => s.key !== "info");
}

/**
 * Active step priority (issue #3):
 * needs-user → ai-working → queued → pending → last work step.
 */
export function activeStep(steps: CardStep[]): CardStep | undefined {
  const work = workSteps(steps);
  return (
    work.find((s) => s.status === "needs-user") ??
    work.find((s) => s.status === "ai-working") ??
    work.find((s) => s.status === "queued") ??
    work.find((s) => s.status === "pending") ??
    work[work.length - 1]
  );
}

/** Info always visible; any step with status pending is hidden. */
export function isTabVisible(step: CardStep): boolean {
  if (step.key === "info") return true;
  if (step.status === "pending") return false;
  return true;
}

export function visibleSteps(steps: CardStep[]): CardStep[] {
  return steps.filter(isTabVisible);
}

export function activeTabKey(steps: CardStep[]): string {
  return activeStep(steps)?.key ?? "info";
}
