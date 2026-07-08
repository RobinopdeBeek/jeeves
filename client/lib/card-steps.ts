import type { Card, CardStep, ColumnId } from "./api";

/** Work steps = everything except the always-present Info tab. */
export function workSteps(steps: CardStep[]): CardStep[] {
  return steps.filter((s) => s.key !== "info");
}

/**
 * Active step priority (issue #1 / #4):
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

/** Post-decide cards show pipeline chrome on the board tile. */
export function showsPipelineChrome(card: Pick<Card, "kind">): boolean {
  return card.kind !== null;
}

/** Work steps in the card's current column (segmented bar segments). */
export function columnWorkSteps(
  steps: CardStep[],
  column: ColumnId,
): CardStep[] {
  return workSteps(steps).filter((s) => s.column === column);
}

/** Needs-you border when any work step needs the user or the card is in Review. */
export function needsUserAttention(card: Pick<Card, "column" | "steps">): boolean {
  return (
    workSteps(card.steps).some((s) => s.status === "needs-user") ||
    card.column === "review"
  );
}
