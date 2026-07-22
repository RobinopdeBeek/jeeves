import type { UIMessage, UIMessageChunk } from "ai";
import type { WSContext } from "hono/ws";
import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { EventBus } from "../execution/events.js";
import type { StepKey } from "../pipelines.js";
import { AcpBridge, type SpawnAcp } from "./chat.js";
import { buildGrillOpeningPrompt } from "./grill-prompt.js";

export type WsClientMessage = { type: "user-message"; text: string };

export type WsServerMessage =
  | { type: "ready"; messages: UIMessage[] }
  | { type: "chunk"; chunk: UIMessageChunk }
  | { type: "status"; status: "ai-working" | "needs-user" }
  | { type: "error"; error: string };

export interface ChatWsDeps {
  store: CardStore;
  artifacts: ArtifactStore;
  events: EventBus;
  spawn: SpawnAcp;
  promptsRoot: string;
}

export interface SessionKey {
  cardId: string;
  stepKey: StepKey;
  round: number;
}

/**
 * One WebSocket ↔ AcpBridge binding for a card step.
 * Outbound payloads are AI SDK types only (ADR 0008).
 */
export class ChatConnection {
  private bridge: AcpBridge | null = null;
  private closed = false;
  private sending = false;

  constructor(
    private readonly ws: WSContext,
    private readonly key: SessionKey,
    private readonly deps: ChatWsDeps,
  ) {}

  async start(): Promise<void> {
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

    try {
      // Spawn + handshake before `ready` so a missing `agent` CLI fails the
      // client connect() instead of hanging on "Starting grill session…".
      const opening = await this.bridge.openSession({
        cwd,
        openingPrompt,
        history,
      });
      this.send({ type: "ready", messages: history });
      await this.forwardChunks(opening);
    } catch (err) {
      this.send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async onClientMessage(raw: string): Promise<void> {
    if (!this.bridge || this.closed || this.sending) return;

    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      this.send({ type: "error", error: "invalid message" });
      return;
    }
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge?.close();
    this.bridge = null;
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
