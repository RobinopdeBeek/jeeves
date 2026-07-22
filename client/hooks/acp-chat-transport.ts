import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

export type PermissionOptionPart = {
  optionId: string;
  name: string;
  kind: string;
};

/** Matches AcpBridge `data-permission` payload (ADR 0008 — no ACP types). */
export type PermissionRequestData = {
  requestId: string;
  toolCallId?: string;
  title?: string;
  options: PermissionOptionPart[];
  status: "pending" | "resolved";
  selectedOptionId?: string;
};

type WsServerMessage =
  | { type: "ready"; messages: UIMessage[]; streaming?: boolean }
  | { type: "session"; status: "open"; streaming?: boolean }
  | { type: "chunk"; chunk: UIMessageChunk }
  | { type: "status"; status: "ai-working" | "needs-user" }
  | { type: "displaced"; reason: string }
  | { type: "error"; error: string };

export interface AcpChatTransportOptions {
  cardId: string;
  stepKey: string;
  round?: number;
  onDisplaced?: (reason: string) => void;
}

/**
 * WebSocket ChatTransport for Grill (and future ai-chat steps).
 * Speaks AI SDK UIMessageChunk only — never ACP types (ADR 0008).
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

  /** Chunks for the eager opening turn, buffered until reconnectToStream reads them. */
  private openingBuffer: UIMessageChunk[] = [];
  private openingDone = false;
  private openingController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;
  private openingConsumed = false;

  private replyController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;

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
        this.markOpeningDone();
        this.replyController?.close();
        this.replyController = null;
        return;
      }
      this.failConnect(new Error("WebSocket closed before grill session was ready"));
      this.markOpeningDone();
      this.replyController?.close();
      this.replyController = null;
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

    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.replyController = controller;
        abortSignal?.addEventListener("abort", () => {
          controller.close();
          this.replyController = null;
        });
      },
    });

    this.socket?.send(JSON.stringify({ type: "user-message", text }));
    return stream;
  }

  /** Approve/deny an inline `data-permission` part via the WebSocket. */
  respondToPermission(requestId: string, optionId: string): void {
    if (!this.socket || this.displaced) return;
    this.socket.send(
      JSON.stringify({ type: "permission-response", requestId, optionId }),
    );
  }

  /**
   * Delivers the buffered (or still-streaming) opening turn when useChat mounts
   * with `resume: true`.
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    await this.connect();
    if (this.openingConsumed) return null;
    this.openingConsumed = true;

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        for (const chunk of this.openingBuffer) {
          controller.enqueue(chunk);
        }
        this.openingBuffer = [];
        if (this.openingDone) {
          controller.close();
        } else {
          this.openingController = controller;
        }
      },
    });
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

  private failConnect(err: Error): void {
    this.rejectReady?.(err);
    this.rejectSession?.(err);
    this.resolveReady = null;
    this.rejectReady = null;
    this.resolveSession = null;
    this.rejectSession = null;
    this.openingController?.error(err);
    this.replyController?.error(err);
    this.openingController = null;
    this.replyController = null;
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
          this.markOpeningDone();
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
            this.markOpeningDone();
          }
        }
        break;
      case "chunk":
        if (this.replyController) {
          this.replyController.enqueue(msg.chunk);
          if (msg.chunk.type === "finish" || msg.chunk.type === "error") {
            this.replyController.close();
            this.replyController = null;
          }
        } else if (this.openingController) {
          this.openingController.enqueue(msg.chunk);
          if (msg.chunk.type === "finish" || msg.chunk.type === "error") {
            this.markOpeningDone();
          }
        } else {
          this.openingBuffer.push(msg.chunk);
          if (msg.chunk.type === "finish" || msg.chunk.type === "error") {
            this.markOpeningDone();
          }
        }
        break;
      case "displaced":
        this.displaced = true;
        this.sessionOpen = false;
        this.options.onDisplaced?.(msg.reason);
        this.markOpeningDone();
        this.replyController?.close();
        this.replyController = null;
        // Drop reject handlers so the ensuing socket close is not an error.
        this.resolveReady = null;
        this.rejectReady = null;
        this.resolveSession = null;
        this.rejectSession = null;
        break;
      case "error":
        this.failConnect(new Error(msg.error));
        this.markOpeningDone();
        break;
      case "status":
        break;
    }
  }

  private markOpeningDone(): void {
    if (this.openingDone) return;
    this.openingDone = true;
    try {
      this.openingController?.close();
    } catch {
      // already closed
    }
    this.openingController = null;
  }
}
