import type { AdvanceSideEffect } from "../pipelines.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";
import type { StepKey } from "../pipelines.js";

export interface EffectDispatchDeps {
  enqueue: (cardId: string, stepKey: StepKey) => void;
  sessions: ChatSessionRegistry;
}

/** Run side-effects declared by PipelineEngine.advance (adapters only). */
export function dispatchAdvanceEffects(
  cardId: string,
  effects: AdvanceSideEffect[],
  deps: EffectDispatchDeps,
): void {
  for (const effect of effects) {
    if (effect.type === "enqueue") {
      deps.enqueue(cardId, effect.stepKey);
    } else if (effect.type === "close-chat") {
      deps.sessions.close(
        { cardId, stepKey: effect.stepKey, round: effect.round },
        effect.reason,
      );
    }
  }
}
