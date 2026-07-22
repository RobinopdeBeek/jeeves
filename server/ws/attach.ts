import type { UIMessage, UIMessageChunk } from "ai";
import type { WSContext } from "hono/ws";
import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { EventBus } from "../execution/events.js";
import { AcpBridge, type SpawnAcp } from "./chat.js";
import { buildGrillOpeningPrompt } from "./grill-prompt.js";
import {
  ChatSessionRegistry,
  type SessionKey,
} from "./session-registry.js";

export type { SessionKey };

export type WsClientMessage =
  | { type: "user-message"; text: string }
  | { type: "permission-response"; requestId: string; optionId: string };

export type WsServerMessage =
  | { type: "ready"; messages: UIMessage[] }
  /** ACP handshake finished — client may send user turns. */
  | { type: "session"; status: "open" }
  | { type: "chunk"; chunk: UIMessageChunk }
  | { type: "status"; status: "ai-working" | "needs-user" }
  | { type: "displaced"; reason: string }
  | { type: "error"; error: string };

export interface ChatWsDeps {
  store: CardStore;
  artifacts: ArtifactStore;
  events: EventBus;
  spawn: SpawnAcp;
  promptsRoot: string;
  /** Shared across sockets — last connection wins per session key. */
  sessions: ChatSessionRegistry;
}

/**
 * One WebSocket ↔ AcpBridge binding for a card step.
 * Outbound payloads are AI SDK types only (ADR 0008).
 */
export class ChatConnection {
  private bridge: AcpBridge | null = null;
  private closed = false;
  private sending = false;
  private displaced = false;

  constructor(
    private readonly ws: WSContext,
    private readonly key: SessionKey,
    private readonly deps: ChatWsDeps,
  ) {}

  async start(): Promise<void> {
    // Claim before ACP cold-start so a racing second tab displaces us cleanly.
    this.deps.sessions.claim(this.key, this);

    const card = this.deps.store.getCard(this.key.cardId);
    if (!card) {
      this.send({ type: "error", error: "card not found" });
      this.ws.close();
      return;
    }

    const history = loadTranscript(this.deps.artifacts, this.key);
    const cwd = this.deps.store.getRepoPath(this.key.cardId);
    const openingPrompt = buildGrillOpeningPrompt(
      {
        title: card.title,
        description: card.description,
        contextPath: path.join(cwd, "CONTEXT.md"),
      },
      this.deps.promptsRoot,
    );

    this.bridge = new AcpBridge({
      spawn: this.deps.spawn,
      onStatus: (status) => {
        const updated = this.deps.store.setStepStatus(
          this.key.cardId,
          this.key.stepKey,
          status,
        );
        this.deps.events.emit({ type: "card.updated", card: updated });
        this.send({ type: "status", status });
      },
      onTranscript: (messages) => {
        this.deps.artifacts.upsertTranscript(
          this.key.cardId,
          this.key.stepKey,
          this.key.round,
          messages,
        );
      },
    });

    // Transcript first so the client can paint history while `agent acp`
    // cold-starts (often 1–3s). Send stays gated on `session` below.
    this.send({ type: "ready", messages: history });

    if (this.closed) return;

    try {
      const opening = await this.bridge.openSession({
        cwd,
        openingPrompt,
        history,
      });
      if (this.closed) return;
      this.send({ type: "session", status: "open" });
      await this.forwardChunks(opening);
    } catch (err) {
      if (this.closed) return;
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async onClientMessage(raw: string): Promise<void> {
    if (!this.bridge || this.closed) return;

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
        this.bridge.respondToPermission(msg.requestId, msg.optionId);
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
      const stream = await this.bridge.sendMessage(msg.text.trim());
      await this.forwardChunks(stream);
    } catch (err) {
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.sending = false;
    }
  }

  /**
   * Last-connection-wins: notify the client, tear down the ACP session, and
   * close the socket. Does not release the registry slot (the new owner claimed it).
   */
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
    this.bridge?.close();
    this.bridge = null;
    if (opts.releaseSlot) {
      this.deps.sessions.release(this.key, this);
    }
  }

  private async forwardChunks(stream: AsyncIterable<UIMessageChunk>): Promise<void> {
    for await (const chunk of stream) {
      if (this.closed) break;
      this.send({ type: "chunk", chunk });
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

function loadTranscript(artifacts: ArtifactStore, key: SessionKey): UIMessage[] {
  const row = artifacts.latest(key.cardId, {
    stepKey: key.stepKey,
    round: key.round,
    kind: "transcript",
  });
  if (!row) return [];
  try {
    const parsed = JSON.parse(artifacts.readContent(row)) as UIMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
