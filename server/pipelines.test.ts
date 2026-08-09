import { describe, expect, it } from "vitest";
import {
  advance,
  canCreateSpec,
  canCreateTasks,
  grillToSpecTransition,
  specToTasksTransition,
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

describe("canCreateTasks", () => {
  it("matches specToTasksTransition.ok", () => {
    const ready = [
      { key: "spec" as const, status: "needs-user" as const },
      { key: "tasks" as const, status: "pending" as const },
    ];
    expect(canCreateTasks(ready)).toBe(true);
    expect(specToTasksTransition(ready).ok).toBe(true);

    const busy = [
      { key: "spec" as const, status: "done" as const },
      { key: "tasks" as const, status: "pending" as const },
    ];
    expect(canCreateTasks(busy)).toBe(false);
  });
});

describe("advance", () => {
  it("kind-decision feature has no enqueue; standalone enqueues plan", () => {
    const feature = advance(
      {
        id: "feat-1",
        kind: null,
        steps: [{ key: "info", status: "needs-user" }],
      },
      { type: "kind-decision", path: "feature" },
    );
    expect(feature.ok).toBe(true);
    if (!feature.ok) return;
    expect(feature.cardPatch).toEqual({ kind: "feature", column: "define" });
    expect(feature.sideEffects).toEqual([]);

    const standalone = advance(
      {
        id: "task-1",
        kind: null,
        steps: [{ key: "info", status: "needs-user" }],
      },
      { type: "kind-decision", path: "standalone" },
    );
    expect(standalone.ok).toBe(true);
    if (!standalone.ok) return;
    expect(standalone.sideEffects).toEqual([
      { type: "enqueue", cardId: "task-1", stepKey: "plan" },
    ]);
  });

  it("grill-to-spec declares close-chat and status patches", () => {
    const plan = advance(
      {
        id: "feat-1",
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

  it("spec-to-tasks declares close-chat and status patches", () => {
    const plan = advance(
      {
        id: "feat-1",
        kind: "feature",
        steps: [
          { key: "spec", status: "needs-user" },
          { key: "tasks", status: "pending" },
        ],
      },
      { type: "spec-to-tasks" },
    );
    expect(plan).toEqual({
      ok: true,
      stepPatches: [
        { key: "spec", status: "done" },
        { key: "tasks", status: "needs-user" },
      ],
      sideEffects: [
        {
          type: "close-chat",
          stepKey: "spec",
          round: 0,
          reason: "spec handed off to tasks",
        },
      ],
    });
  });

  it("step-finished Plan success queues Implement on the same card", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "ai-working" },
            { key: "impl", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "plan", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [
        { key: "plan", status: "done" },
        { key: "impl", status: "queued" },
      ],
      sideEffects: [
        { type: "enqueue", cardId: "task-1", stepKey: "impl" },
      ],
    });
  });

  it("step-finished Plan failure parks needs-user without enqueueing Implement", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "ai-working" },
            { key: "impl", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "plan", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "plan", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished Implement success queues AI Review on the same card", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "done" },
            { key: "impl", status: "ai-working" },
            { key: "airev", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "impl", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [
        { key: "impl", status: "done" },
        { key: "airev", status: "queued" },
      ],
      sideEffects: [
        { type: "enqueue", cardId: "task-1", stepKey: "airev" },
      ],
    });
  });

  it("step-finished Implement failure parks needs-user without enqueueing AI Review", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "done" },
            { key: "impl", status: "ai-working" },
            { key: "airev", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "impl", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "impl", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished AI Review success moves to Review with Prepare Eval queued", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "done" },
            { key: "impl", status: "done" },
            { key: "airev", status: "ai-working" },
          ],
        },
        { type: "step-finished", stepKey: "airev", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      cardPatch: { kind: "task", column: "review" },
      ensureSteps: [
        { key: "prepeval", status: "queued" },
        { key: "review", status: "pending" },
      ],
      stepPatches: [{ key: "airev", status: "done" }],
      sideEffects: [
        { type: "enqueue", cardId: "task-1", stepKey: "prepeval" },
      ],
    });
  });

  it("step-finished AI Review failure parks needs-user without advancing column", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "done" },
            { key: "impl", status: "done" },
            { key: "airev", status: "ai-working" },
          ],
        },
        { type: "step-finished", stepKey: "airev", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "airev", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished Prepare Eval success marks prepeval done and human review needs-user", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          column: "review",
          steps: [
            { key: "prepeval", status: "ai-working" },
            { key: "review", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "prepeval", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [
        { key: "prepeval", status: "done" },
        { key: "review", status: "needs-user" },
      ],
      sideEffects: [],
    });
  });

  it("step-finished Prepare Eval failure parks needs-user without unlocking review", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          column: "review",
          steps: [
            { key: "prepeval", status: "ai-working" },
            { key: "review", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "prepeval", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "prepeval", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished for other steps still maps outcome to done / needs-user", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [{ key: "review", status: "needs-user" }],
        },
        { type: "step-finished", stepKey: "review", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "review", status: "done" }],
      sideEffects: [],
    });
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [{ key: "document", status: "ai-working" }],
        },
        { type: "step-finished", stepKey: "document", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "document", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("tasks-to-implement ensures feature branch and closes chat", () => {
    const plan = advance(
      {
        id: "feat-1",
        kind: "feature",
        steps: [
          { key: "spec", status: "done" },
          { key: "tasks", status: "needs-user" },
        ],
      },
      { type: "tasks-to-implement" },
    );
    expect(plan).toEqual({
      ok: true,
      stepPatches: [{ key: "tasks", status: "awaiting" }],
      sideEffects: [
        { type: "ensure-branch", cardId: "feat-1" },
        {
          type: "close-chat",
          stepKey: "tasks",
          round: 0,
          reason: "tasks handed off to implement",
        },
      ],
    });
  });

  it("tasks-to-implement rejects when Tasks is not needs-user", () => {
    const plan = advance(
      {
        id: "feat-1",
        kind: "feature",
        steps: [
          { key: "spec", status: "done" },
          { key: "tasks", status: "awaiting" },
        ],
      },
      { type: "tasks-to-implement" },
    );
    expect(plan.ok).toBe(false);
  });
});
