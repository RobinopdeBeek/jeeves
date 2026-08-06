import type { WSContext } from "hono/ws";
import type {
  ChatAttachment,
  WsClientMessage,
  WsServerMessage,
} from "../../shared/chat-ws.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { ChatThreadStore } from "../chat-threads/store.js";
import type { EventBus } from "../execution/events.js";
import type { SpawnAcp } from "./chat.js";
import {
  createProjectChatSession,
  createStepChatSession,
  stepChatSessionIdFromRef,
  stepChatTurnCompleteHook,
  threadChatSessionId,
  type ChatSession,
  type ProjectChatRef,
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

/** Discriminated open target resolved from the `/ws/chat` query string. */
export type ChatOpenTarget =
  | { kind: "step"; ref: StepChatRef }
  | { kind: "thread"; ref: ProjectChatRef };

export interface ChatWsDeps {
  store: CardStore;
  artifacts: ArtifactStore;
  events: EventBus;
  spawn: SpawnAcp;
  promptsRoot: string;
  sessions: ChatSessionRegistry;
  chatThreads: ChatThreadStore;
  /** Main Project checkout for Project Chat. */
  projectCwd: string;
}

/**
 * Thin WebSocket adapter: resolve ChatSession once, send ready (with optional
 * branchable for Project Chat), then one openChat path for both kinds.
 */
export class ChatConnection {
  private handle: WarmSessionHandle | null = null;
  private closed = false;
  private sending = false;
  private displaced = false;
  /** Single-slot buffer for a user-message that arrives before ACP is open. */
  private pendingUserMessage: WsClientMessage | null = null;
  private readonly sessionId: string;
  private readonly subscriber: ChunkSubscriber = {
    onChunk: (chunk) => this.send({ type: "chunk", chunk }),
  };

  constructor(
    private readonly ws: WSContext,
    private readonly target: ChatOpenTarget,
    private readonly deps: ChatWsDeps,
  ) {
    this.sessionId =
      target.kind === "step"
        ? stepChatSessionIdFromRef(target.ref)
        : threadChatSessionId(target.ref.threadId);
  }

  async start(): Promise<void> {
    this.deps.sessions.claim(this.sessionId, this);

    let session: ChatSession;
    try {
      session = this.resolveSession();
    } catch (err) {
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      this.ws.close();
      return;
    }

    // Ready before openChat so frozen-transcript / spawn failures still get history first.
    try {
      this.sendReady(session);
    } catch (err) {
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      this.ws.close();
      return;
    }
    if (this.closed) return;

    try {
      await this.finishOpen(session);
    } catch (err) {
      this.sendOpenError(err);
    }
  }

  private resolveSession(): ChatSession {
    if (this.target.kind === "step") {
      const ref = this.target.ref;
      if (!this.deps.store.getCard(ref.cardId)) {
        throw new Error("card not found");
      }
      const sessionDeps = {
        store: this.deps.store,
        artifacts: this.deps.artifacts,
        events: this.deps.events,
        promptsRoot: this.deps.promptsRoot,
      };
      return createStepChatSession(ref, sessionDeps, {
        onStatusNotify: (status) => {
          if (this.closed) return;
          this.send({ type: "status", status });
        },
        onTurnComplete: stepChatTurnCompleteHook(ref, sessionDeps, {
          send: (msg) => this.send(msg),
          sendError: (error) => this.send({ type: "error", error }),
          isClosed: () => this.closed,
        }),
      });
    }

    const ref = this.target.ref;
    if (!this.deps.chatThreads.getThread(ref.threadId)) {
      throw new Error("thread not found");
    }
    return createProjectChatSession(ref, {
      threads: this.deps.chatThreads,
      cwd: this.deps.projectCwd,
    });
  }

  private sendReady(session: ChatSession): void {
    const messages = session.loadTranscript();
    if (this.target.kind === "thread") {
      this.send({
        type: "ready",
        messages,
        streaming: this.deps.sessions.isAiWorking(this.sessionId),
        branchable: this.deps.chatThreads.loadBranchable(
          this.target.ref.threadId,
        ),
      });
      return;
    }
    this.send({
      type: "ready",
      messages,
      streaming: this.deps.sessions.isAiWorking(this.sessionId),
    });
  }

  private async finishOpen(session: ChatSession): Promise<void> {
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
      promptCapabilities: this.handle.getPromptCapabilities(),
    });
    await this.flushPendingUserMessage();
  }

  private sendOpenError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // A chat that never opens is otherwise invisible in the dev terminal.
    console.error(`chat session ${this.sessionId} failed to open: ${message}`);
    if (this.closed) return;
    this.send({ type: "error", error: message });
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

    if (!this.handle) {
      // Park one early prompt; flushed at the end of finishOpen().
      if (msg.type === "user-message") {
        this.pendingUserMessage = msg;
      }
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

    // Stop must work mid-turn — do not wait for `sending` to clear.
    if (msg.type === "cancel") {
      this.handle.cancelTurn();
      return;
    }

    if (msg.type !== "user-message") {
      this.send({ type: "error", error: "unsupported message" });
      return;
    }

    await this.deliverUserMessage(msg);
  }

  private async flushPendingUserMessage(): Promise<void> {
    const pending = this.pendingUserMessage;
    this.pendingUserMessage = null;
    if (!pending || this.closed || !this.handle) return;
    await this.deliverUserMessage(pending);
  }

  private async deliverUserMessage(msg: WsClientMessage): Promise<void> {
    if (!this.handle || this.sending) return;
    if (msg.type !== "user-message" || typeof msg.text !== "string") {
      this.send({ type: "error", error: "unsupported message" });
      return;
    }

    let attachments: ChatAttachment[] = [];
    try {
      attachments = parseClientAttachments(msg.attachments);
    } catch (err) {
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const text = msg.text.trim();
    if (!text && attachments.length === 0) {
      this.send({ type: "error", error: "unsupported message" });
      return;
    }

    this.sending = true;
    try {
      const liveDraftBody =
        typeof msg.liveDraftBody === "string" ? msg.liveDraftBody : undefined;
      await this.handle.sendMessage(text, {
        liveDraftBody,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
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
    this.pendingUserMessage = null;
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

/** Coerce/validate the optional attachments array from a client user-message. */
function parseClientAttachments(raw: unknown): ChatAttachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("attachments must be an array");
  }
  const out: ChatAttachment[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") {
      throw new Error("invalid attachment");
    }
    const att = item as Record<string, unknown>;
    if (typeof att.mediaType !== "string" || typeof att.url !== "string") {
      throw new Error("attachment requires mediaType and url");
    }
    out.push({
      mediaType: att.mediaType,
      url: att.url,
      ...(typeof att.filename === "string" ? { filename: att.filename } : {}),
    });
  }
  return out;
}
