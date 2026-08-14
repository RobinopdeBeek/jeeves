import { describe, expect, it } from "vitest";
import {
  advance,
  canCreateSpec,
  canCreateTasks,
  executionQueueIndex,
  grillToSpecTransition,
  specToTasksTransition,
} from "./pipelines.js";

describe("executionQueueIndex", () => {
  it("orders plan < implement < ai-review < prepare-human-review and ignores other steps", () => {
    expect(executionQueueIndex("plan")).toBe(0);
    expect(executionQueueIndex("implement")).toBe(1);
    expect(executionQueueIndex("ai-review")).toBe(2);
    expect(executionQueueIndex("prepare-human-review")).toBe(3);
    expect(executionQueueIndex("human-review")).toBeUndefined();
    expect(executionQueueIndex("grill")).toBeUndefined();
  });
});

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
            { key: "implement", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "plan", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [
        { key: "plan", status: "done" },
        { key: "implement", status: "queued" },
      ],
      sideEffects: [
        { type: "enqueue", cardId: "task-1", stepKey: "implement" },
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
            { key: "implement", status: "pending" },
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
            { key: "implement", status: "ai-working" },
            { key: "ai-review", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "implement", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [
        { key: "implement", status: "done" },
        { key: "ai-review", status: "queued" },
      ],
      sideEffects: [
        { type: "enqueue", cardId: "task-1", stepKey: "ai-review" },
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
            { key: "implement", status: "ai-working" },
            { key: "ai-review", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "implement", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "implement", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished AI Review success moves to Review with Prepare Human Review queued", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [
            { key: "plan", status: "done" },
            { key: "implement", status: "done" },
            { key: "ai-review", status: "ai-working" },
          ],
        },
        { type: "step-finished", stepKey: "ai-review", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      cardPatch: { kind: "task", column: "review" },
      ensureSteps: [
        { key: "prepare-human-review", status: "queued" },
        { key: "human-review", status: "pending" },
      ],
      stepPatches: [{ key: "ai-review", status: "done" }],
      sideEffects: [
        { type: "enqueue", cardId: "task-1", stepKey: "prepare-human-review" },
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
            { key: "implement", status: "done" },
            { key: "ai-review", status: "ai-working" },
          ],
        },
        { type: "step-finished", stepKey: "ai-review", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "ai-review", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished Prepare Human Review success marks the step done and Human Review needs-user", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          column: "review",
          steps: [
            { key: "prepare-human-review", status: "ai-working" },
            { key: "human-review", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "prepare-human-review", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [
        { key: "prepare-human-review", status: "done" },
        { key: "human-review", status: "needs-user" },
      ],
      sideEffects: [],
    });
  });

  it("step-finished Prepare Human Review failure parks needs-user without unlocking Human Review", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          column: "review",
          steps: [
            { key: "prepare-human-review", status: "ai-working" },
            { key: "human-review", status: "pending" },
          ],
        },
        { type: "step-finished", stepKey: "prepare-human-review", outcome: "failed" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "prepare-human-review", status: "needs-user" }],
      sideEffects: [],
    });
  });

  it("step-finished for other steps still maps outcome to done / needs-user", () => {
    expect(
      advance(
        {
          id: "task-1",
          kind: "task",
          steps: [{ key: "human-review", status: "needs-user" }],
        },
        { type: "step-finished", stepKey: "human-review", outcome: "succeeded" },
      ),
    ).toEqual({
      ok: true,
      stepPatches: [{ key: "human-review", status: "done" }],
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
