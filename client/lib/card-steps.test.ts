import { describe, expect, it } from "vitest";
import {
  activeStep,
  activeTabKey,
  columnWorkSteps,
  isTabVisible,
  needsUserAttention,
  showsPipelineChrome,
  visibleSteps,
} from "./card-steps";
import type { CardStep } from "./api";

const featureAfterDecide: CardStep[] = [
  { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
  { key: "grill", status: "needs-user", label: "Grill", stepKind: "ai-chat", column: "define" },
  { key: "prd", status: "pending", label: "PRD", stepKind: "ai-chat", column: "define" },
  { key: "tasks", status: "pending", label: "Tasks", stepKind: "ai-execution", column: "define" },
];

const standaloneAfterDecide: CardStep[] = [
  { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
  { key: "plan", status: "queued", label: "Plan", stepKind: "ai-execution", column: "implement" },
  { key: "impl", status: "pending", label: "Implement", stepKind: "ai-execution", column: "implement" },
  { key: "airev", status: "pending", label: "AI Review", stepKind: "ai-execution", column: "implement" },
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
      { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
      { key: "plan", status: "queued", label: "Plan", stepKind: "ai-execution", column: "implement" },
      { key: "impl", status: "pending", label: "Implement", stepKind: "ai-execution", column: "implement" },
    ];
    expect(activeStep(steps)?.key).toBe("plan");
  });

  describe("tile derivation", () => {
    it("shows pipeline chrome only after kind decision", () => {
      expect(showsPipelineChrome({ kind: null })).toBe(false);
      expect(showsPipelineChrome({ kind: "feature" })).toBe(true);
      expect(showsPipelineChrome({ kind: "task" })).toBe(true);
    });

    it("filters segmented bar to current-column work steps", () => {
      expect(columnWorkSteps(featureAfterDecide, "define").map((s) => s.key)).toEqual([
        "grill",
        "prd",
        "tasks",
      ]);
      expect(columnWorkSteps(standaloneAfterDecide, "implement").map((s) => s.key)).toEqual([
        "plan",
        "impl",
        "airev",
      ]);
      expect(columnWorkSteps(featureAfterDecide, "implement")).toEqual([]);
    });

    it("flags needs-user attention from work steps or Review column", () => {
      expect(
        needsUserAttention({ column: "define", steps: featureAfterDecide }),
      ).toBe(true);

      const idleDefine: CardStep[] = [
        { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
        { key: "grill", status: "done", label: "Grill", stepKind: "ai-chat", column: "define" },
        { key: "prd", status: "ai-working", label: "PRD", stepKind: "ai-chat", column: "define" },
        { key: "tasks", status: "pending", label: "Tasks", stepKind: "ai-execution", column: "define" },
      ];
      expect(needsUserAttention({ column: "define", steps: idleDefine })).toBe(false);

      const reviewSteps: CardStep[] = [
        { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
        { key: "review", status: "done", label: "Human Review", stepKind: "human", column: "review" },
      ];
      expect(needsUserAttention({ column: "review", steps: reviewSteps })).toBe(true);
    });
  });
});
