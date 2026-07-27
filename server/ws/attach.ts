import type { WSContext } from "hono/ws";
import type {
  WsClientMessage,
  WsServerMessage,
} from "../../shared/chat-ws.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { EventBus } from "../execution/events.js";
import type { SpawnAcp } from "./chat.js";
import { loadTranscript, openChat } from "./open-chat.js";
import {
  ChatSessionRegistry,
  type ChunkSubscriber,
  type SessionKey,
  type WarmSessionHandle,
} from "./session-registry.js";

export type { SessionKey };
export type { WsClientMessage, WsServerMessage };

export interface ChatWsDeps {
  store: CardStore;
  artifacts: ArtifactStore;
  events: EventBus;
  spawn: SpawnAcp;
  promptsRoot: string;
  sessions: ChatSessionRegistry;
}

/**
 * Thin WebSocket adapter over openChat / warm registry.
 * Outbound payloads are AI SDK types only (ADR 0008).
 */
export class ChatConnection {
  private handle: WarmSessionHandle | null = null;
  private closed = false;
  private sending = false;
  private displaced = false;
  private readonly subscriber: ChunkSubscriber = {
    onChunk: (chunk) => this.send({ type: "chunk", chunk }),
  };

  constructor(
    private readonly ws: WSContext,
    private readonly key: SessionKey,
    private readonly deps: ChatWsDeps,
  ) {}

  async start(): Promise<void> {
    this.deps.sessions.claim(this.key, this);

    if (!this.deps.store.getCard(this.key.cardId)) {
      this.send({ type: "error", error: "card not found" });
      this.ws.close();
      return;
    }

    this.send({
      type: "ready",
      messages: loadTranscript(this.deps.artifacts, this.key),
      streaming: this.deps.sessions.isAiWorking(this.key),
    });
    if (this.closed) return;

    try {
      const opened = await openChat(this.key, this.deps, {
        onStatusNotify: (status) => {
          if (!this.closed) this.send({ type: "status", status });
        },
      });
      if (this.closed) return;

      this.handle = opened.handle;
      this.handle.attach(this.subscriber);
      this.send({
        type: "session",
        status: "open",
        streaming: this.deps.sessions.isAiWorking(this.key),
      });
    } catch (err) {
      if (this.closed) return;
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async onClientMessage(raw: string): Promise<void> {
    if (!this.handle || this.closed) return;

    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      this.send({ type: "error", error: "invalid message" });
      return;
    }

    if (msg.type === "permission-response") {
      if (typeof msg.requestId !== "string" || typeof msg.optionId !== "string") {
        this.send({ type: "error", error: "invalid permission-response" });
        return;
      }
      try {
        this.handle.respondToPermission(msg.requestId, msg.optionId);
      } catch (err) {
        this.send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (this.sending) return;
    if (msg.type !== "user-message" || typeof msg.text !== "string" || !msg.text.trim()) {
      this.send({ type: "error", error: "unsupported message" });
      return;
    }

    this.sending = true;
    try {
      await this.handle.sendMessage(msg.text.trim());
    } catch (err) {
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.sending = false;
    }
  }

  displace(reason: string): void {
    if (this.closed || this.displaced) return;
    this.displaced = true;
    this.send({ type: "displaced", reason });
    this.shutdown({ releaseSlot: false });
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  close(): void {
    this.shutdown({ releaseSlot: !this.displaced });
  }

  private shutdown(opts: { releaseSlot: boolean }): void {
    if (this.closed) return;
    this.closed = true;
    this.handle?.detach(this.subscriber);
    this.handle = null;
    if (opts.releaseSlot) {
      this.deps.sessions.release(this.key, this);
    }
  }

  private send(msg: WsServerMessage): void {
    if (this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Client gone.
    }
  }
}
