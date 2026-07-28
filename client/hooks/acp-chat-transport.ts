import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { WsClientMessage, WsServerMessage } from "@shared/chat-ws";
import type { TasksDraft } from "@/lib/api";

export type { PermissionOptionPart, PermissionRequestData } from "@shared/chat-ws";

/** Socket health, for reconnect UI. */
export type ChatConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface AcpChatTransportOptions {
  cardId: string;
  stepKey: string;
  round?: number;
  onDisplaced?: (reason: string) => void;
  /** Spec side-chat: inject live editor draft into the agent prompt (not the UI). */
  getCurrentSpecMarkdown?: () => string;
  /** Spec side-chat: host harvested a revision — replace editor content. */
  onSpecRevised?: (markdown: string) => void;
  /** Tasks side-chat: inject live tip JSON into the agent prompt (not the UI). */
  getCurrentTasksDraftJson?: () => string;
  /** Tasks side-chat: host harvested a revision — refresh tip tiles. */
  onTasksRevised?: (draft: TasksDraft & { versionCount?: number }) => void;
  /** Notify when a turn starts/ends streaming (editor/composer lock). */
  onStreamingChange?: (streaming: boolean) => void;
  /** Socket health changed (reconnect banner, composer gating). */
  onConnectionChange?: (state: ChatConnectionState) => void;
  /**
   * A dropped socket came back. The `ready` transcript is authoritative — the
   * hook remounts the chat runtime with it rather than splicing streams.
   */
  onReconnected?: (
    history: UIMessage[],
    opts: { streaming: boolean },
  ) => void;
}

/** Backoff for reconnect attempts; last value repeats. */
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
/** Give up (and surface an error) if the very first connect never lands. */
const MAX_INITIAL_ATTEMPTS = 4;
const PING_TIMEOUT_MS = 2000;
/** A frame this recent means the socket is provably alive — skip the ping. */
const LIVENESS_FRESH_MS = 3000;
/** Silent stretch during a turn before we probe the socket. */
const TURN_LIVENESS_INTERVAL_MS = 8000;
/** How long a send waits for a healthy session before failing loudly. */
const ENSURE_LIVE_TIMEOUT_MS = 8000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  settled: boolean;
};

function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // Nobody may be awaiting when a generation is torn down.
  promise.catch(() => {});
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => {
      if (d.settled) return;
      d.settled = true;
      resolveFn(value);
    },
    reject: (err) => {
      if (d.settled) return;
      d.settled = true;
      rejectFn(err);
    },
  };
  return d;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closedStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream({ start: (c) => c.close() });
}

/**
 * WebSocket ChatTransport for Grill (and future ai-chat steps).
 * Speaks AI SDK UIMessageChunk only — never ACP types (ADR 0008).
 *
 * One inbound consumer: chunks buffer until a ReadableStream attaches
 * (reconnectToStream for the opening/warm turn, sendMessages for replies).
 *
 * Self-healing: a socket that dies (dev-server restart, sleep, network blip)
 * is reconnected with backoff, and every send first proves the socket is
 * really alive — a lost frame must never leave the composer spinning.
 */
export class AcpChatTransport {
  private socket: WebSocket | null = null;
  /** Bumped per socket; stale handlers check it before touching state. */
  private generation = 0;
  private readyD = deferred<UIMessage[]>();
  private sessionD = deferred<void>();
  private sessionOpen = false;
  private displaced = false;
  /** Set by close() — no reconnects after the hook tears us down. */
  private closedByUs = false;
  /** Server rejected this session (bad card, …) — retrying cannot help. */
  private fatal = false;
  private hasConnected = false;
  private lastHistory: UIMessage[] = [];
  private lastServerMessageAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: ChatConnectionState = "connecting";
  private pingSeq = 0;
  private readonly pingWaiters = new Map<string, Deferred<void>>();
  private wakeListenersBound = false;

  /** Chunks for the current turn until a stream consumer attaches. */
  private chunkBuffer: UIMessageChunk[] = [];
  private streamController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;
  private turnDone = false;
  /** Opening / warm catch-up stream is consumed at most once via reconnectToStream. */
  private resumeConsumed = false;
  /**
   * True when ready had empty history or an in-flight turn — session may
   * briefly report streaming:false before opening chunks arrive; do not treat
   * that as end-of-turn.
   */
  private expectOpeningStream = false;

  private readonly onWake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    this.reconnectNow();
  };

  constructor(private readonly options: AcpChatTransportOptions) {}

  /** True once the ACP session handshake finished (send is allowed). */
  isSessionOpen(): boolean {
    return this.sessionOpen && this.isSocketUsable() && !this.displaced;
  }

  /** Resolves when the server signals the ACP session is ready for user turns. */
  whenSessionOpen(): Promise<void> {
    if (this.isSessionOpen()) return Promise.resolve();
    return this.sessionD.promise;
  }

  getConnectionState(): ChatConnectionState {
    return this.connectionState;
  }

  /** Ensures a socket is up (opening or reconnecting as needed). */
  async connect(): Promise<UIMessage[]> {
    if (this.closedByUs) throw new Error("chat transport is closed");
    this.bindWakeListeners();
    if (this.isSocketUsable() && this.readyD.settled) return this.lastHistory;
    if (!this.socket) {
      this.openSocket();
    } else if (this.socket.readyState !== WebSocket.CONNECTING) {
      // Stale socket that never fired close — don't hand back cached history.
      this.reconnectNow();
    }
    return this.readyD.promise;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser
      ? lastUser.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : "";
    if (!text.trim()) return closedStream();

    // Pre-send health check: heal a dead/half-open socket before we commit the
    // turn, so a stale connection can never swallow the prompt.
    await this.ensureLive();
    if (this.displaced) return closedStream();

    this.beginTurn();
    const stream = this.openChunkStream(abortSignal);
    const currentSpecMarkdown = this.options.getCurrentSpecMarkdown?.();
    const currentTasksDraftJson = this.options.getCurrentTasksDraftJson?.();
    try {
      this.sendClient({
        type: "user-message",
        text,
        ...(currentSpecMarkdown != null ? { currentSpecMarkdown } : {}),
        ...(currentTasksDraftJson != null ? { currentTasksDraftJson } : {}),
      });
    } catch (err) {
      this.abandonTurn();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.armLivenessWatch();
    return stream;
  }

  /** Approve/deny an inline `data-permission` part via the WebSocket. */
  respondToPermission(requestId: string, optionId: string): void {
    if (this.displaced) return;
    try {
      this.sendClient({ type: "permission-response", requestId, optionId });
    } catch {
      // Socket died between render and click — reconnect re-seeds the pending
      // permission from the warm bridge.
      this.reconnectNow();
    }
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
    this.closedByUs = true;
    this.clearLivenessTimer();
    this.clearReconnectTimer();
    this.unbindWakeListeners();
    this.failPings();

    const socket = this.socket;
    this.socket = null;
    if (!socket) return;

    // Drop handlers so an intentional teardown doesn't reject `ready` /
    // streams after the hook has already moved on.
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

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

  private isSocketUsable(): boolean {
    return this.socket != null && this.socket.readyState === WebSocket.OPEN;
  }

  private url(): string {
    const qs = new URLSearchParams({
      cardId: this.options.cardId,
      stepKey: this.options.stepKey,
      round: String(this.options.round ?? 0),
    });
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws/chat?${qs}`;
  }

  private openSocket(): void {
    if (this.closedByUs || this.displaced || this.fatal) return;

    this.generation += 1;
    const gen = this.generation;
    if (this.readyD.settled) this.readyD = deferred();
    if (this.sessionD.settled) this.sessionD = deferred();
    this.sessionOpen = false;
    this.setConnectionState(this.hasConnected ? "reconnecting" : "connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url());
    } catch {
      this.handleSocketDown(gen);
      return;
    }
    this.socket = socket;

    socket.onmessage = (event) => {
      if (gen !== this.generation) return;
      this.handleServerMessage(String(event.data));
    };
    socket.onerror = () => {
      // `close` always follows; recovery happens there.
    };
    socket.onclose = () => {
      if (gen !== this.generation) return;
      this.handleSocketDown(gen);
    };
  }

  /** Socket is gone (or provably dead): unlock the UI and start recovery. */
  private handleSocketDown(gen: number): void {
    if (gen !== this.generation) return;
    if (this.closedByUs || this.displaced || this.fatal) return;

    this.socket = null;
    this.sessionOpen = false;
    this.clearLivenessTimer();
    this.failPings();
    // A turn cannot survive a dead socket — end the stream so the composer
    // unlocks; the reconnect re-seeds from the server transcript.
    this.abandonTurn();

    if (this.readyD.settled) this.readyD = deferred();
    if (this.sessionD.settled) this.sessionD = deferred();

    this.setConnectionState("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    if (this.closedByUs || this.displaced || this.fatal) return;

    if (!this.hasConnected && this.reconnectAttempt >= MAX_INITIAL_ATTEMPTS) {
      const err = new Error("could not reach the chat session");
      this.readyD.reject(err);
      this.sessionD.reject(err);
      this.setConnectionState("closed");
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Reconnect immediately (tab focus, network back, dead socket on send). */
  private reconnectNow(): void {
    if (this.closedByUs || this.displaced || this.fatal) return;
    if (this.isSocketUsable()) return;
    // A handshake already in flight will resolve or fail on its own.
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    if (this.socket) this.handleSocketDown(this.generation);
    // Skip the backoff scheduled by handleSocketDown — this path is driven by
    // the user sending or the tab/network waking up.
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /**
   * Health check with repair. Resolves only when a usable socket has an open
   * ACP session; throws when that cannot be reached in time.
   */
  private async ensureLive(): Promise<void> {
    if (this.closedByUs) throw new Error("chat session is closed");
    if (this.displaced) return;

    if (this.isSocketUsable() && this.sessionOpen) {
      if (await this.verifyLive()) return;
      // Half-open socket: readyState says OPEN but nothing answers.
      this.dropDeadSocket();
    }

    this.reconnectNow();

    const deadline = Date.now() + ENSURE_LIVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.closedByUs) throw new Error("chat session is closed");
      if (this.displaced) return;
      if (this.isSocketUsable() && this.sessionOpen) return;
      await Promise.race([
        this.sessionD.promise.catch(() => undefined),
        sleep(100),
      ]);
    }
    throw new Error("chat session is not connected — reconnecting, try again");
  }

  /** True when the socket is provably alive (recent frame or a pong). */
  private async verifyLive(): Promise<boolean> {
    if (!this.isSocketUsable()) return false;
    if (Date.now() - this.lastServerMessageAt < LIVENESS_FRESH_MS) return true;
    return this.pingRoundTrip();
  }

  private async pingRoundTrip(): Promise<boolean> {
    const socket = this.socket;
    if (!socket || !this.isSocketUsable()) return false;

    const id = `p${++this.pingSeq}`;
    const waiter = deferred<void>();
    this.pingWaiters.set(id, waiter);
    try {
      socket.send(JSON.stringify({ type: "ping", id } satisfies WsClientMessage));
    } catch {
      this.pingWaiters.delete(id);
      return false;
    }

    const timer = setTimeout(
      () => waiter.reject(new Error("ping timeout")),
      PING_TIMEOUT_MS,
    );
    try {
      await waiter.promise;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      this.pingWaiters.delete(id);
    }
  }

  private failPings(): void {
    for (const waiter of this.pingWaiters.values()) {
      waiter.reject(new Error("connection lost"));
    }
    this.pingWaiters.clear();
  }

  /** Force a half-open socket closed and route through recovery. */
  private dropDeadSocket(): void {
    const socket = this.socket;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
    this.handleSocketDown(this.generation);
  }

  /** Probe the socket after a silent stretch mid-turn. */
  private armLivenessWatch(): void {
    this.clearLivenessTimer();
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      if (this.turnDone || this.closedByUs || this.displaced) return;
      void (async () => {
        const alive = await this.verifyLive();
        if (this.turnDone || this.closedByUs || this.displaced) return;
        if (!alive) {
          this.dropDeadSocket();
          this.reconnectNow();
          return;
        }
        this.armLivenessWatch();
      })();
    }, TURN_LIVENESS_INTERVAL_MS);
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer != null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private bindWakeListeners(): void {
    if (this.wakeListenersBound) return;
    if (typeof window === "undefined") return;
    if (typeof window.addEventListener !== "function") return;
    this.wakeListenersBound = true;
    window.addEventListener("online", this.onWake);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onWake);
    }
  }

  private unbindWakeListeners(): void {
    if (!this.wakeListenersBound) return;
    this.wakeListenersBound = false;
    window.removeEventListener("online", this.onWake);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onWake);
    }
  }

  private setConnectionState(state: ChatConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.options.onConnectionChange?.(state);
  }

  private sendClient(msg: WsClientMessage): void {
    if (!this.isSocketUsable()) {
      throw new Error("chat connection is not open");
    }
    this.socket!.send(JSON.stringify(msg));
  }

  private beginTurn(): void {
    this.closeActiveStream();
    this.chunkBuffer = [];
    this.turnDone = false;
    this.options.onStreamingChange?.(true);
  }

  /** End a turn that can no longer complete, so the UI stops waiting. */
  private abandonTurn(): void {
    const hadStream = this.streamController != null;
    this.closeActiveStream();
    if (!hadStream && this.turnDone) return;
    this.turnDone = true;
    this.clearLivenessTimer();
    this.options.onStreamingChange?.(false);
  }

  private openChunkStream(
    abortSignal?: AbortSignal,
  ): ReadableStream<UIMessageChunk> {
    let attached: ReadableStreamDefaultController<UIMessageChunk> | null =
      null;
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
        attached = controller;
        this.streamController = controller;
        abortSignal?.addEventListener("abort", () => {
          this.releaseStreamController(controller, { close: true });
        });
      },
      // AI SDK / assistant-ui may cancel the resume stream on send,
      // Chat recreation (thread id change), or teardown — drop the stale
      // controller so later WS chunks buffer, and allow a later
      // reconnectToStream while the turn is still live.
      cancel: () => {
        if (attached && this.streamController === attached) {
          this.streamController = null;
        }
        if (!this.turnDone) {
          this.resumeConsumed = false;
        }
      },
    });
  }

  private pushChunk(chunk: UIMessageChunk): void {
    const controller = this.streamController;
    if (controller) {
      try {
        controller.enqueue(chunk);
      } catch {
        // Consumer cancelled/closed the stream out from under us.
        this.streamController = null;
        this.chunkBuffer.push(chunk);
        if (chunk.type === "finish" || chunk.type === "error") {
          this.markTurnDone();
        }
        return;
      }
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

  /** Close (optional) and drop a controller only if it is still the active one. */
  private releaseStreamController(
    controller: ReadableStreamDefaultController<UIMessageChunk>,
    opts: { close: boolean },
  ): void {
    if (this.streamController !== controller) return;
    if (opts.close) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
    this.streamController = null;
  }

  private markTurnDone(): void {
    if (this.turnDone) return;
    this.turnDone = true;
    this.clearLivenessTimer();
    this.closeActiveStream();
    this.options.onStreamingChange?.(false);
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
    this.readyD.reject(err);
    this.sessionD.reject(err);
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
    this.lastServerMessageAt = Date.now();

    switch (msg.type) {
      case "ready": {
        const reconnected = this.hasConnected;
        this.hasConnected = true;
        this.reconnectAttempt = 0;
        this.lastHistory = msg.messages;
        // Fresh generation: this socket replays the live turn from scratch.
        this.chunkBuffer = [];
        this.resumeConsumed = false;
        this.turnDone = false;
        // Empty history or mid-stream warm reattach ⇒ expect chunks (or a
        // second resume after Chat recreation cancels the first stream).
        this.expectOpeningStream =
          msg.messages.length === 0 || Boolean(msg.streaming);
        // Non-empty history ⇒ opening is done unless warm reattach is mid-stream.
        if (msg.messages.length > 0 && !msg.streaming) {
          this.markTurnDone();
        }
        this.readyD.resolve(msg.messages);
        if (reconnected) {
          this.options.onReconnected?.(msg.messages, {
            streaming: Boolean(msg.streaming),
          });
        }
        break;
      }
      case "session":
        if (msg.status === "open") {
          this.sessionOpen = true;
          this.sessionD.resolve();
          this.setConnectionState("open");
          // Authoritative only when we are not waiting on an opening/warm turn.
          // ready is sent before openChat; session can report idle while the
          // opening prompt is still starting.
          if (!msg.streaming && !this.expectOpeningStream) {
            this.markTurnDone();
          }
        }
        break;
      case "chunk":
        this.pushChunk(msg.chunk);
        break;
      case "pong":
        this.pingWaiters.get(msg.id)?.resolve();
        break;
      case "displaced":
        this.displaced = true;
        this.sessionOpen = false;
        this.clearReconnectTimer();
        this.clearLivenessTimer();
        this.setConnectionState("closed");
        this.options.onDisplaced?.(msg.reason);
        this.markTurnDone();
        break;
      case "error": {
        // Before session open ⇒ setup failure (bad card, spawn failed):
        // reconnecting would just loop. After ⇒ a turn failed; keep the socket.
        const setupFailure = !this.sessionOpen;
        if (setupFailure) {
          this.fatal = true;
          this.clearReconnectTimer();
          this.setConnectionState("closed");
          this.failConnect(new Error(msg.error));
        } else {
          try {
            this.streamController?.error(new Error(msg.error));
          } catch {
            // already closed
          }
          this.streamController = null;
        }
        this.markTurnDone();
        break;
      }
      case "spec-revised":
        this.options.onSpecRevised?.(msg.markdown);
        break;
      case "tasks-revised":
        this.options.onTasksRevised?.({
          ...msg.draft,
          versionCount: msg.versionCount,
        });
        break;
    }
  }
}
