import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { WsClientMessage, WsServerMessage } from "@shared/chat-ws";

export type { PermissionOptionPart, PermissionRequestData } from "@shared/chat-ws";

export interface AcpChatTransportOptions {
  cardId: string;
  stepKey: string;
  round?: number;
  onDisplaced?: (reason: string) => void;
}

/**
 * WebSocket ChatTransport for Grill (and future ai-chat steps).
 * Speaks AI SDK UIMessageChunk only — never ACP types (ADR 0008).
 *
 * One inbound consumer: chunks buffer until a ReadableStream attaches
 * (reconnectToStream for the opening/warm turn, sendMessages for replies).
 */
export class AcpChatTransport {
  private socket: WebSocket | null = null;
  private ready: Promise<UIMessage[]> | null = null;
  private resolveReady: ((messages: UIMessage[]) => void) | null = null;
  private rejectReady: ((err: Error) => void) | null = null;

  private session: Promise<void> | null = null;
  private resolveSession: (() => void) | null = null;
  private rejectSession: ((err: Error) => void) | null = null;
  private sessionOpen = false;
  private displaced = false;

  /** Chunks for the current turn until a stream consumer attaches. */
  private chunkBuffer: UIMessageChunk[] = [];
  private streamController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;
  private turnDone = false;
  /** Opening / warm catch-up stream is consumed at most once via reconnectToStream. */
  private resumeConsumed = false;

  constructor(private readonly options: AcpChatTransportOptions) {}

  /** True once the ACP session handshake finished (send is allowed). */
  isSessionOpen(): boolean {
    return this.sessionOpen && !this.displaced;
  }

  /** Resolves when the server signals the ACP session is ready for user turns. */
  whenSessionOpen(): Promise<void> {
    if (this.sessionOpen) return Promise.resolve();
    if (!this.session) {
      this.session = new Promise<void>((resolve, reject) => {
        this.resolveSession = resolve;
        this.rejectSession = reject;
      });
    }
    return this.session;
  }

  /** Ensures the socket is up and returns the server's ready history. */
  async connect(): Promise<UIMessage[]> {
    if (this.ready) return this.ready;

    this.ready = new Promise<UIMessage[]>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    if (!this.session) {
      this.session = new Promise<void>((resolve, reject) => {
        this.resolveSession = resolve;
        this.rejectSession = reject;
      });
    }

    const round = this.options.round ?? 0;
    const qs = new URLSearchParams({
      cardId: this.options.cardId,
      stepKey: this.options.stepKey,
      round: String(round),
    });
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/chat?${qs}`;

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onmessage = (event) => {
      this.handleServerMessage(String(event.data));
    };
    socket.onerror = () => {
      if (this.displaced) return;
      this.failConnect(new Error("WebSocket error"));
    };
    socket.onclose = () => {
      if (this.displaced) {
        this.closeActiveStream();
        return;
      }
      this.failConnect(new Error("WebSocket closed before grill session was ready"));
      this.markTurnDone();
    };

    return this.ready;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    await this.connect();
    await this.whenSessionOpen();
    if (this.displaced) {
      return new ReadableStream({ start: (c) => c.close() });
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser
      ? lastUser.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : "";
    if (!text.trim()) {
      return new ReadableStream({ start: (c) => c.close() });
    }

    this.beginTurn();
    const stream = this.openChunkStream(abortSignal);
    this.sendClient({ type: "user-message", text });
    return stream;
  }

  /** Approve/deny an inline `data-permission` part via the WebSocket. */
  respondToPermission(requestId: string, optionId: string): void {
    if (!this.socket || this.displaced) return;
    this.sendClient({ type: "permission-response", requestId, optionId });
  }

  /**
   * Delivers the buffered (or still-streaming) opening/warm turn when useChat
   * mounts with `resume: true`.
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    await this.connect();
    if (this.resumeConsumed) return null;
    this.resumeConsumed = true;
    return this.openChunkStream();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;

    // Drop handlers so an intentional teardown doesn't reject `ready` /
    // streams after the hook has already moved on.
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.resolveSession = null;
    this.rejectSession = null;

    if (socket.readyState === WebSocket.CONNECTING) {
      // Closing while CONNECTING triggers Chrome's "closed before the
      // connection is established" console error; wait for open, then close.
      socket.addEventListener("open", () => socket.close());
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }

  private sendClient(msg: WsClientMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private beginTurn(): void {
    this.closeActiveStream();
    this.chunkBuffer = [];
    this.turnDone = false;
  }

  private openChunkStream(
    abortSignal?: AbortSignal,
  ): ReadableStream<UIMessageChunk> {
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        for (const chunk of this.chunkBuffer) {
          controller.enqueue(chunk);
        }
        this.chunkBuffer = [];
        if (this.turnDone) {
          controller.close();
          return;
        }
        this.streamController = controller;
        abortSignal?.addEventListener("abort", () => {
          if (this.streamController === controller) {
            controller.close();
            this.streamController = null;
          }
        });
      },
    });
  }

  private pushChunk(chunk: UIMessageChunk): void {
    if (this.streamController) {
      this.streamController.enqueue(chunk);
      if (chunk.type === "finish" || chunk.type === "error") {
        this.markTurnDone();
      }
      return;
    }
    this.chunkBuffer.push(chunk);
    if (chunk.type === "finish" || chunk.type === "error") {
      this.markTurnDone();
    }
  }

  private markTurnDone(): void {
    if (this.turnDone) return;
    this.turnDone = true;
    this.closeActiveStream();
  }

  private closeActiveStream(): void {
    try {
      this.streamController?.close();
    } catch {
      // already closed
    }
    this.streamController = null;
  }

  private failConnect(err: Error): void {
    this.rejectReady?.(err);
    this.rejectSession?.(err);
    this.resolveReady = null;
    this.rejectReady = null;
    this.resolveSession = null;
    this.rejectSession = null;
    try {
      this.streamController?.error(err);
    } catch {
      // already closed
    }
    this.streamController = null;
  }

  private handleServerMessage(raw: string): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw) as WsServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "ready":
        this.resolveReady?.(msg.messages);
        this.resolveReady = null;
        this.rejectReady = null;
        // Empty history ⇒ server will stream an opening turn.
        // Non-empty history ⇒ opening is done unless warm reattach is mid-stream.
        if (msg.messages.length > 0 && !msg.streaming) {
          this.markTurnDone();
        }
        break;
      case "session":
        if (msg.status === "open") {
          this.sessionOpen = true;
          this.resolveSession?.();
          this.resolveSession = null;
          this.rejectSession = null;
          // Authoritative: turn may have finished between ready and attach.
          if (!msg.streaming) {
            this.markTurnDone();
          }
        }
        break;
      case "chunk":
        this.pushChunk(msg.chunk);
        break;
      case "displaced":
        this.displaced = true;
        this.sessionOpen = false;
        this.options.onDisplaced?.(msg.reason);
        this.markTurnDone();
        // Drop reject handlers so the ensuing socket close is not an error.
        this.resolveReady = null;
        this.rejectReady = null;
        this.resolveSession = null;
        this.rejectSession = null;
        break;
      case "error":
        this.failConnect(new Error(msg.error));
        this.markTurnDone();
        break;
      case "status":
        break;
    }
  }
}
