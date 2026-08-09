import type { AdvanceSideEffect } from "../pipelines.js";
import { stepChatSessionId } from "../ws/chat-session.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";
import type { StepKey } from "../pipelines.js";

export interface EffectDispatchDeps {
  enqueue: (cardId: string, stepKey: StepKey) => void;
  /** Create/record a durable card branch (git + cards.branch). */
  ensureBranch?: (cardId: string) => void | Promise<void>;
  /** Required when effects include close-chat. */
  sessions?: ChatSessionRegistry;
}

/**
 * Run side-effects declared by PipelineEngine.advance / CardStore.fanOut /
 * ExecutionEngine.finishStep. ensure-branch runs before enqueue so child Plan
 * sees the feature branch.
 */
export async function dispatchAdvanceEffects(
  cardId: string,
  effects: AdvanceSideEffect[],
  deps: EffectDispatchDeps,
): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "ensure-branch") {
      if (!deps.ensureBranch) {
        throw new Error("ensure-branch effect requires ensureBranch dispatch dep");
      }
      await deps.ensureBranch(effect.cardId);
    } else if (effect.type === "enqueue") {
      deps.enqueue(effect.cardId, effect.stepKey);
    } else if (effect.type === "close-chat") {
      if (!deps.sessions) {
        throw new Error("close-chat effect requires sessions dispatch dep");
      }
      deps.sessions.close(
        stepChatSessionId(cardId, effect.stepKey, effect.round),
        effect.reason,
      );
    }
  }
}
