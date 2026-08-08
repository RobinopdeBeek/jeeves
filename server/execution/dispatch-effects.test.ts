import { describe, expect, it, vi } from "vitest";
import { dispatchAdvanceEffects } from "./dispatch-effects.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";

describe("dispatchAdvanceEffects", () => {
  it("ensures branches before enqueueing named child cards", async () => {
    const order: string[] = [];
    const sessions = {
      close: vi.fn(),
    } as unknown as ChatSessionRegistry;

    await dispatchAdvanceEffects(
      "feature-1",
      [
        { type: "ensure-branch", cardId: "feature-1" },
        {
          type: "close-chat",
          stepKey: "tasks",
          round: 0,
          reason: "tasks handed off to implement",
        },
        { type: "enqueue", cardId: "child-a", stepKey: "plan" },
        { type: "enqueue", cardId: "child-b", stepKey: "plan" },
      ],
      {
        enqueue: (id, step) => {
          order.push(`enqueue:${id}:${step}`);
        },
        ensureBranch: async (id) => {
          order.push(`ensure-branch:${id}`);
        },
        sessions,
      },
    );

    expect(order).toEqual([
      "ensure-branch:feature-1",
      "enqueue:child-a:plan",
      "enqueue:child-b:plan",
    ]);
    expect(sessions.close).toHaveBeenCalledWith(
      expect.stringContaining("feature-1"),
      "tasks handed off to implement",
    );
  });

  it("enqueues using effect.cardId, not only the parent argument", async () => {
    const enqueued: Array<{ id: string; step: string }> = [];
    await dispatchAdvanceEffects(
      "parent",
      [{ type: "enqueue", cardId: "child-x", stepKey: "plan" }],
      {
        enqueue: (id, step) => enqueued.push({ id, step }),
        sessions: { close: vi.fn() } as unknown as ChatSessionRegistry,
      },
    );
    expect(enqueued).toEqual([{ id: "child-x", step: "plan" }]);
  });
});
