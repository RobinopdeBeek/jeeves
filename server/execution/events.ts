import type { CardWithSteps } from "../cards/store.js";

/** Events broadcast to every connected board/card view over SSE. */
export type JeevesEvent =
  | { type: "card.updated"; card: CardWithSteps }
  | { type: "run.log"; runId: string; cardId: string; line: string }
  | {
      type: "run.finished";
      runId: string;
      cardId: string;
      status: "succeeded" | "failed";
      error?: string;
    };

/**
 * In-process pub/sub behind `GET /api/events`. Subscribers are SSE
 * connections (and tests); emit never throws even if a subscriber does.
 */
export class EventBus {
  private readonly listeners = new Set<(event: JeevesEvent) => void>();

  subscribe(listener: (event: JeevesEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: JeevesEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take down a run.
      }
    }
  }
}
