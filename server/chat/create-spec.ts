import type { ArtifactStore } from "../artifacts/store.js";
import {
  CardStoreError,
  type CardStore,
  type CardWithSteps,
} from "../cards/store.js";
import {
  GrillSessionExtractError,
  type ExtractGrillSession,
} from "./grill-session-extract.js";
import {
  SpecSynthesisError,
  type SynthesizeSpec,
} from "./to-spec-synthesis.js";
import { dispatchAdvanceEffects } from "../execution/dispatch-effects.js";
import type { ExecutionEngine } from "../execution/engine.js";
import type { EventBus } from "../execution/events.js";
import { loadTranscript } from "../ws/open-chat.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";

export class CreateSpecError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CreateSpecError";
    this.status = status;
  }
}

export interface CreateSpecInput {
  cardId: string;
  repoPath: string;
  promptsRoot: string;
}

/**
 * Grill → Spec host op: extract session, synthesize Spec, advance steps.
 * Fails closed before hand-off when extract or synthesis fails.
 */
export type CreateSpec = (input: CreateSpecInput) => Promise<CardWithSteps>;

export function createCreateSpec(deps: {
  store: CardStore;
  artifacts: ArtifactStore;
  sessions: ChatSessionRegistry;
  engine: ExecutionEngine;
  events: EventBus;
  extractGrillSession: ExtractGrillSession;
  synthesizeSpec: SynthesizeSpec;
}): CreateSpec {
  return async (input) => {
    // Validate before extract / ACP teardown so a 409 leaves the session intact.
    deps.store.assertGrillToSpecHandOff(input.cardId);
    const cardBefore = deps.store.getCard(input.cardId);
    if (!cardBefore) {
      throw new CardStoreError(404, "card not found");
    }

    // Durable for the process lifetime of this op — CardView remounts (board
    // navigation) read creatingSpec from GET/SSE instead of local React state.
    deps.store.setCreatingSpec(input.cardId, true);
    const started = deps.store.getCard(input.cardId);
    if (started) {
      deps.events.emit({ type: "card.updated", card: started });
    }

    try {
      const transcript = loadTranscript(deps.artifacts, {
        cardId: input.cardId,
        stepKey: "grill",
        round: 0,
      });
      if (transcript.length === 0) {
        throw new CreateSpecError("grill transcript is empty", 422);
      }

      let grillBody: string;
      try {
        grillBody = await deps.extractGrillSession({
          transcript,
          repoPath: input.repoPath,
          promptsRoot: input.promptsRoot,
        });
      } catch (e) {
        const message =
          e instanceof GrillSessionExtractError
            ? e.message
            : e instanceof Error
              ? e.message
              : "grill-session extract failed";
        throw new CreateSpecError(message, 502);
      }

      deps.artifacts.save({
        cardId: input.cardId,
        stepKey: "grill",
        round: 0,
        kind: "grill",
        content: grillBody,
        sourceSkill: "grill-session",
      });

      // Freeze Grill chat before headless /to-spec (closes warm ACP).
      dispatchAdvanceEffects(
        input.cardId,
        [
          {
            type: "close-chat",
            stepKey: "grill",
            round: 0,
            reason: "closing grill for spec synthesis",
          },
        ],
        {
          enqueue: (id, step) => deps.engine.enqueue(id, step),
          sessions: deps.sessions,
        },
      );

      try {
        await deps.synthesizeSpec({
          cardId: input.cardId,
          repoPath: input.repoPath,
          grillSession: grillBody,
          cardTitle: cardBefore.title,
          cardDescription: cardBefore.description,
          promptsRoot: input.promptsRoot,
        });
      } catch (e) {
        const message =
          e instanceof SpecSynthesisError
            ? e.message
            : e instanceof Error
              ? e.message
              : "spec synthesis failed";
        throw new CreateSpecError(message, 502);
      }

      deps.store.handOffGrillToSpec(input.cardId);
    } finally {
      deps.store.setCreatingSpec(input.cardId, false);
      const settled = deps.store.getCard(input.cardId);
      if (settled) {
        deps.events.emit({ type: "card.updated", card: settled });
      }
    }

    const card = deps.store.getCard(input.cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    return card;
  };
}
