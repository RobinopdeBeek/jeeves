import { useEffect, useRef } from "react";
import type { Card } from "./api";

export type JeevesEvent =
  | { type: "card.updated"; card: Card }
  | { type: "run.log"; runId: string; cardId: string; line: string }
  | {
      type: "run.finished";
      runId: string;
      cardId: string;
      status: "succeeded" | "failed";
      error?: string;
    };

const EVENT_NAMES = ["card.updated", "run.log", "run.finished"] as const;

// One EventSource per tab, shared by board and card views. EventSource
// auto-reconnects; consumers use the reconnect callback to re-fetch state
// (e.g. the log tail) that streamed past during the gap.
let source: EventSource | null = null;
let everOpened = false;
const subscribers = new Set<(event: JeevesEvent) => void>();
const reconnectSubscribers = new Set<() => void>();

function ensureSource(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    if (everOpened) for (const fn of reconnectSubscribers) fn();
    everOpened = true;
  };
  for (const name of EVENT_NAMES) {
    source.addEventListener(name, (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as JeevesEvent;
      for (const fn of subscribers) fn(event);
    });
  }
}

/** Subscribe to the live board channel for the lifetime of the component. */
export function useJeevesEvents(
  onEvent: (event: JeevesEvent) => void,
  onReconnect?: () => void,
): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const reconnectHandler = useRef(onReconnect);
  reconnectHandler.current = onReconnect;

  useEffect(() => {
    ensureSource();
    const fn = (event: JeevesEvent) => handler.current(event);
    const onOpen = () => reconnectHandler.current?.();
    subscribers.add(fn);
    reconnectSubscribers.add(onOpen);
    return () => {
      subscribers.delete(fn);
      reconnectSubscribers.delete(onOpen);
    };
  }, []);
}
