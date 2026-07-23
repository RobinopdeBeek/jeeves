import { describe, expect, it } from "vitest";
import {
  advance,
  canCreateSpec,
  grillToSpecTransition,
} from "./pipelines.js";

describe("canCreateSpec", () => {
  it("matches grillToSpecTransition.ok", () => {
    const ready = [
      { key: "grill" as const, status: "needs-user" as const },
      { key: "spec" as const, status: "pending" as const },
    ];
    expect(canCreateSpec(ready)).toBe(true);
    expect(grillToSpecTransition(ready).ok).toBe(true);

    const busy = [
      { key: "grill" as const, status: "ai-working" as const },
      { key: "spec" as const, status: "pending" as const },
    ];
    expect(canCreateSpec(busy)).toBe(false);
  });
});

describe("advance", () => {
  it("kind-decision feature has no enqueue; standalone enqueues plan", () => {
    const feature = advance(
      { kind: null, steps: [{ key: "info", status: "needs-user" }] },
      { type: "kind-decision", path: "feature" },
    );
    expect(feature.ok).toBe(true);
    if (!feature.ok) return;
    expect(feature.cardPatch).toEqual({ kind: "feature", column: "define" });
    expect(feature.sideEffects).toEqual([]);

    const standalone = advance(
      { kind: null, steps: [{ key: "info", status: "needs-user" }] },
      { type: "kind-decision", path: "standalone" },
    );
    expect(standalone.ok).toBe(true);
    if (!standalone.ok) return;
    expect(standalone.sideEffects).toEqual([
      { type: "enqueue", stepKey: "plan" },
    ]);
  });

  it("grill-to-spec declares close-chat and status patches", () => {
    const plan = advance(
      {
        kind: "feature",
        steps: [
          { key: "grill", status: "needs-user" },
          { key: "spec", status: "pending" },
        ],
      },
      { type: "grill-to-spec" },
    );
    expect(plan).toEqual({
      ok: true,
      stepPatches: [
        { key: "grill", status: "done" },
        { key: "spec", status: "needs-user" },
      ],
      sideEffects: [
        {
          type: "close-chat",
          stepKey: "grill",
          round: 0,
          reason: "grill handed off to spec",
        },
      ],
    });
  });

  it("step-finished maps outcome to done / needs-user", () => {
    expect(
      advance(
        { kind: "task", steps: [{ key: "plan", status: "ai-working" }] },
        { type: "step-finished", stepKey: "plan", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "plan", status: "done" }],
      sideEffects: [],
    });
    expect(
      advance(
        { kind: "task", steps: [{ key: "plan", status: "ai-working" }] },
        { type: "step-finished", stepKey: "plan", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "plan", status: "needs-user" }],
      sideEffects: [],
    });
  });
});
