import { describe, expect, it } from "vitest";
import {
  activeStep,
  activeTabKey,
  isTabVisible,
  visibleSteps,
} from "./card-steps";
import type { CardStep } from "./api";

const featureAfterDecide: CardStep[] = [
  { key: "info", status: "done", label: "Info", stepKind: "human" },
  { key: "grill", status: "needs-user", label: "Grill", stepKind: "ai-chat" },
  { key: "prd", status: "pending", label: "PRD", stepKind: "ai-chat" },
  { key: "tasks", status: "pending", label: "Tasks", stepKind: "ai-execution" },
];

const standaloneAfterDecide: CardStep[] = [
  { key: "info", status: "done", label: "Info", stepKind: "human" },
  { key: "plan", status: "queued", label: "Plan", stepKind: "ai-execution" },
  { key: "impl", status: "pending", label: "Implement", stepKind: "ai-execution" },
  { key: "airev", status: "pending", label: "AI Review", stepKind: "ai-execution" },
];

describe("card-steps", () => {
  it("hides pending steps from the tab bar", () => {
    expect(visibleSteps(featureAfterDecide).map((s) => s.key)).toEqual([
      "info",
      "grill",
    ]);
    expect(visibleSteps(standaloneAfterDecide).map((s) => s.key)).toEqual([
      "info",
      "plan",
    ]);
  });

  it("always shows Info", () => {
    expect(isTabVisible(featureAfterDecide[0])).toBe(true);
  });

  it("resolves active step with needs-user first", () => {
    expect(activeStep(featureAfterDecide)?.key).toBe("grill");
    expect(activeTabKey(featureAfterDecide)).toBe("grill");
  });

  it("falls through to queued when no needs-user or ai-working", () => {
    const steps: CardStep[] = [
      { key: "info", status: "done", label: "Info", stepKind: "human" },
      { key: "plan", status: "queued", label: "Plan", stepKind: "ai-execution" },
      { key: "impl", status: "pending", label: "Implement", stepKind: "ai-execution" },
    ];
    expect(activeStep(steps)?.key).toBe("plan");
  });
});
