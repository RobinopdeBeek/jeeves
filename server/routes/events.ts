import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../execution/events.js";

/**
 * `GET /api/events` — the single live channel shared by board and card
 * views. Broadcasts card.updated, run.log, and run.finished.
 */
export function eventRoutes(events: EventBus) {
  const app = new Hono();

  app.get("/", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const unsubscribe = events.subscribe((event) => {
        void stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(id++),
        });
      });

      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" });
      }, 25_000);

      const closed = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      try {
        await closed;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }),
  );

  return app;
}
