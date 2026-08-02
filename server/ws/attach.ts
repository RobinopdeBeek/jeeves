import type { WSContext } from "hono/ws";
import type {
  WsClientMessage,
  WsServerMessage,
} from "../../shared/chat-ws.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { EventBus } from "../execution/events.js";
import type { SpawnAcp } from "./chat.js";
import {
  createStepChatSession,
  loadTranscript,
  stepChatSessionIdFromRef,
  stepChatTurnCompleteHook,
  type StepChatRef,
} from "./chat-session.js";
import { openChat } from "./open-chat.js";
import {
  ChatSessionRegistry,
  type ChunkSubscriber,
  type WarmSessionHandle,
} from "./session-registry.js";

export type { StepChatRef as SessionKey };
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
 * Thin WebSocket adapter: resolves a ChatSession at the boundary, then
 * openChat / warm registry stay card-agnostic.
 * Outbound payloads are AI SDK types only (ADR 0008).
 */
export class ChatConnection {
  private handle: WarmSessionHandle | null = null;
  private closed = false;
  private sending = false;
  private displaced = false;
  private readonly sessionId: string;
  private readonly subscriber: ChunkSubscriber = {
    onChunk: (chunk) => this.send({ type: "chunk", chunk }),
  };

  constructor(
    private readonly ws: WSContext,
    private readonly ref: StepChatRef,
    private readonly deps: ChatWsDeps,
  ) {
    this.sessionId = stepChatSessionIdFromRef(ref);
  }

  async start(): Promise<void> {
    this.deps.sessions.claim(this.sessionId, this);

    if (!this.deps.store.getCard(this.ref.cardId)) {
      this.send({ type: "error", error: "card not found" });
      this.ws.close();
      return;
    }

    const sessionDeps = {
      store: this.deps.store,
      artifacts: this.deps.artifacts,
      events: this.deps.events,
      promptsRoot: this.deps.promptsRoot,
    };

    // Ready before openChat so frozen-transcript / spawn failures still get history first.
    this.send({
      type: "ready",
      messages: loadTranscript(this.deps.artifacts, this.ref),
      streaming: this.deps.sessions.isAiWorking(this.sessionId),
    });
    if (this.closed) return;

    try {
      const session = createStepChatSession(this.ref, sessionDeps, {
        onStatusNotify: (status) => {
          if (this.closed) return;
          this.send({ type: "status", status });
        },
        onTurnComplete: stepChatTurnCompleteHook(this.ref, sessionDeps, {
          send: (msg) => this.send(msg),
          sendError: (error) => this.send({ type: "error", error }),
          isClosed: () => this.closed,
        }),
      });

      const opened = await openChat(session, {
        spawn: this.deps.spawn,
        sessions: this.deps.sessions,
      });
      if (this.closed) return;

      this.handle = opened.handle;
      this.handle.attach(this.subscriber);
      this.send({
        type: "session",
        status: "open",
        streaming: this.deps.sessions.isAiWorking(this.sessionId),
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
    if (this.closed) return;

    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      this.send({ type: "error", error: "invalid message" });
      return;
    }

    // Answered before the ACP session exists — the client probes liveness
    // while the agent is still starting up.
    if (msg.type === "ping") {
      this.send({ type: "pong", id: typeof msg.id === "string" ? msg.id : "" });
      return;
    }

    if (!this.handle) return;

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

    // Stop must work mid-turn — do not wait for `sending` to clear.
    if (msg.type === "cancel") {
      this.handle.cancelTurn();
      return;
    }

    if (this.sending) return;
    if (msg.type !== "user-message" || typeof msg.text !== "string" || !msg.text.trim()) {
      this.send({ type: "error", error: "unsupported message" });
      return;
    }

    this.sending = true;
    try {
      const liveDraftBody =
        typeof msg.liveDraftBody === "string" ? msg.liveDraftBody : undefined;
      await this.handle.sendMessage(msg.text.trim(), { liveDraftBody });
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
      this.deps.sessions.release(this.sessionId, this);
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
