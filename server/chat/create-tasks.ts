import type { ArtifactStore } from "../artifacts/store.js";
import {
  CardStoreError,
  type CardStore,
  type CardWithSteps,
} from "../cards/store.js";
import { dispatchAdvanceEffects } from "../execution/dispatch-effects.js";
import type { ExecutionEngine } from "../execution/engine.js";
import type { EventBus } from "../execution/events.js";
import type { RunStore } from "../execution/run-store.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";
import {
  TasksDraftSynthesisError,
  type SynthesizeTasksDraft,
} from "./to-tasks-synthesis.js";

export class CreateTasksError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CreateTasksError";
    this.status = status;
  }
}

export interface CreateTasksInput {
  cardId: string;
  repoPath: string;
  promptsRoot: string;
}

/**
 * Spec → Tasks host op: close Spec chat, synthesize tasks-draft, advance steps.
 * Fails closed before hand-off when synthesis fails. Records a `runs` row.
 */
export type CreateTasks = (input: CreateTasksInput) => Promise<CardWithSteps>;

export function createCreateTasks(deps: {
  store: CardStore;
  artifacts: ArtifactStore;
  sessions: ChatSessionRegistry;
  engine: ExecutionEngine;
  events: EventBus;
  runs: RunStore;
  synthesizeTasksDraft: SynthesizeTasksDraft;
}): CreateTasks {
  return async (input) => {
    // Validate before ACP teardown so a 409 leaves the Spec session intact.
    deps.store.assertSpecToTasksHandOff(input.cardId);
    const cardBefore = deps.store.getCard(input.cardId);
    if (!cardBefore) {
      throw new CardStoreError(404, "card not found");
    }

    const latestSpec = deps.artifacts.latest(input.cardId, {
      stepKey: "spec",
      round: 0,
      kind: "spec",
    });
    const specBody = latestSpec ? deps.artifacts.readBody(latestSpec) : "";
    if (!specBody.trim()) {
      throw new CreateTasksError("spec body is empty", 422);
    }

    const grillArtifact = deps.artifacts.latest(input.cardId, {
      stepKey: "grill",
      round: 0,
      kind: "grill",
    });
    const grillSession = grillArtifact
      ? deps.artifacts.readBody(grillArtifact)
      : "";

    deps.store.setCreatingTasks(input.cardId, true);
    const started = deps.store.getCard(input.cardId);
    if (started) {
      deps.events.emit({ type: "card.updated", card: started });
    }

    const run = deps.runs.create({
      cardId: input.cardId,
      stepKey: "tasks",
      skill: "to-draft-tasks",
      logPath: "",
    });
    const logPath = deps.artifacts.liveLogPath(input.cardId, 0, run.id);
    deps.runs.setLogPath(run.id, logPath);

    try {
      // Freeze Spec chat before headless /to-draft-tasks (closes warm ACP).
      dispatchAdvanceEffects(
        input.cardId,
        [
          {
            type: "close-chat",
            stepKey: "spec",
            round: 0,
            reason: "closing spec for tasks synthesis",
          },
        ],
        {
          enqueue: (id, step) => deps.engine.enqueue(id, step),
          sessions: deps.sessions,
        },
      );

      try {
        await deps.synthesizeTasksDraft({
          cardId: input.cardId,
          repoPath: input.repoPath,
          spec: specBody,
          grillSession,
          cardTitle: cardBefore.title,
          cardDescription: cardBefore.description,
          promptsRoot: input.promptsRoot,
        });
      } catch (e) {
        const message =
          e instanceof TasksDraftSynthesisError
            ? e.message
            : e instanceof Error
              ? e.message
              : "tasks-draft synthesis failed";
        deps.runs.finish(run.id, { status: "failed", error: message });
        throw new CreateTasksError(message, 502);
      }

      deps.runs.finish(run.id, { status: "succeeded" });
      deps.store.handOffSpecToTasks(input.cardId);
    } finally {
      deps.store.setCreatingTasks(input.cardId, false);
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
