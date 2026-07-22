import type { UIMessage, UIMessageChunk } from "ai";
import type { StepKey } from "../pipelines.js";
import { AcpBridge, type SpawnAcp } from "./chat.js";

export interface SessionKey {
  cardId: string;
  stepKey: StepKey;
  round: number;
}

/** Minimal seam for last-connection-wins — ChatConnection implements this. */
export interface DisplaceableConnection {
  displace(reason: string): void;
}

/** Receives projected UIMessage chunks while attached to a warm session. */
export interface ChunkSubscriber {
  onChunk(chunk: UIMessageChunk): void;
}

export interface AcquireParams {
  spawn: SpawnAcp;
  cwd: string;
  openingPrompt: string;
  history: UIMessage[];
  onStatus: (status: "ai-working" | "needs-user") => void;
  onTranscript: (messages: UIMessage[]) => void;
}

/** Cap on live ACP bridges across all chat steps (issue #24). */
export const MAX_LIVE_SESSIONS = 5;

export function sessionKeyString(key: SessionKey): string {
  return `${key.cardId}:${key.stepKey}:${key.round}`;
}

/**
 * One live writer per (card, step, round) plus warm AcpBridge ownership.
 * WebSocket connections subscribe; close detaches without killing the bridge.
 */
export class ChatSessionRegistry {
  private readonly active = new Map<string, DisplaceableConnection>();
  private readonly warm = new Map<string, WarmEntry>();
  /** Serializes cold acquires so the live-session cap cannot be overrun. */
  private admitChain: Promise<void> = Promise.resolve();

  get(key: SessionKey): DisplaceableConnection | undefined {
    return this.active.get(sessionKeyString(key));
  }

  hasWarm(key: SessionKey): boolean {
    return this.warm.has(sessionKeyString(key));
  }

  /** True when a warm bridge exists and a turn is in flight (catch-up expected). */
  isAiWorking(key: SessionKey): boolean {
    return this.warm.get(sessionKeyString(key))?.isAiWorking() ?? false;
  }

  claim(key: SessionKey, connection: DisplaceableConnection): void {
    const id = sessionKeyString(key);
    const previous = this.active.get(id);
    if (previous && previous !== connection) {
      previous.displace("session continued elsewhere");
    }
    this.active.set(id, connection);
  }

  release(key: SessionKey, connection: DisplaceableConnection): void {
    const id = sessionKeyString(key);
    if (this.active.get(id) === connection) {
      this.active.delete(id);
    }
  }

  /**
   * Tear down a live writer and warm bridge (e.g. grill → spec hand-off).
   * Displaces the connection so the client sees a reason, then clears both slots.
   */
  close(key: SessionKey, reason: string): void {
    const id = sessionKeyString(key);
    const conn = this.active.get(id);
    if (conn) {
      conn.displace(reason);
      this.active.delete(id);
    }
    const entry = this.warm.get(id);
    if (entry) {
      entry.kill();
      this.warm.delete(id);
    }
  }

  /**
   * Reuse a live bridge for this key, or spawn one (after cap eviction if needed).
   */
  async acquire(key: SessionKey, params: AcquireParams): Promise<WarmSessionHandle> {
    const id = sessionKeyString(key);
    const existing = this.warm.get(id);
    if (existing) {
      existing.updateCallbacks(params);
      return existing.handle(true);
    }

    return this.withAdmitLock(async () => {
      const again = this.warm.get(id);
      if (again) {
        again.updateCallbacks(params);
        return again.handle(true);
      }
      await this.ensureCapacity();
      const entry = new WarmEntry(params);
      this.warm.set(id, entry);
      await entry.open();
      return entry.handle(false);
    });
  }

  private async withAdmitLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.admitChain;
    let release!: () => void;
    this.admitChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async ensureCapacity(): Promise<void> {
    if (this.warm.size < MAX_LIVE_SESSIONS) return;

    // 1. Longest-inactive idle with no subscriber.
    const idleDetached = [...this.warm.entries()]
      .filter(([, e]) => e.isIdleDetached())
      .sort((a, b) => a[1].inactiveSince - b[1].inactiveSince);
    if (idleDetached.length > 0) {
      const [evictId, entry] = idleDetached[0]!;
      this.evictWarm(evictId, entry, "session evicted for capacity");
      return;
    }

    // 2. Not ai-working but still has a subscriber — displace the quietest.
    const idleAttached = [...this.warm.entries()]
      .filter(([, e]) => !e.isAiWorking())
      .sort((a, b) => a[1].inactiveSince - b[1].inactiveSince);
    if (idleAttached.length > 0) {
      const [evictId, entry] = idleAttached[0]!;
      this.evictWarm(evictId, entry, "session evicted for capacity");
      return;
    }

    // 3. All ai-working — wait for the longest-running turn, then evict.
    const busy = [...this.warm.entries()].sort(
      (a, b) => a[1].turnStartedAt - b[1].turnStartedAt,
    );
    const [evictId, entry] = busy[0]!;
    await entry.whenIdle();
    if (this.warm.get(evictId) === entry) {
      this.evictWarm(evictId, entry, "session evicted for capacity");
    }
    if (this.warm.size >= MAX_LIVE_SESSIONS) {
      await this.ensureCapacity();
    }
  }

  private evictWarm(id: string, entry: WarmEntry, reason: string): void {
    const conn = this.active.get(id);
    if (conn) {
      conn.displace(reason);
      this.active.delete(id);
    }
    entry.kill();
    this.warm.delete(id);
  }
}

export interface WarmSessionHandle {
  reused: boolean;
  attach(subscriber: ChunkSubscriber): void;
  detach(subscriber: ChunkSubscriber): void;
  sendMessage(text: string): Promise<void>;
  respondToPermission(requestId: string, optionId: string): void;
  getPendingPermissionIds(): string[];
}

class WarmEntry {
  private bridge: AcpBridge;
  private subscriber: ChunkSubscriber | null = null;
  /** All chunks of the current turn — replayed in full on (re)attach. */
  private turnChunks: UIMessageChunk[] = [];
  private activity: "idle" | "ai-working" = "idle";
  private turnDone: Promise<void> = Promise.resolve();
  private resolveTurnDone: (() => void) | null = null;
  /** Epoch ms when the current turn started; 0 when idle. */
  turnStartedAt = 0;
  /** Epoch ms when we last became idle with no subscriber. */
  inactiveSince = Date.now();
  private readonly params: AcquireParams;

  constructor(params: AcquireParams) {
    this.params = params;
    this.bridge = new AcpBridge({
      spawn: params.spawn,
      onStatus: (status) => {
        if (status === "ai-working") {
          this.activity = "ai-working";
          this.turnStartedAt = Date.now();
          this.turnChunks = [];
          this.turnDone = new Promise((resolve) => {
            this.resolveTurnDone = resolve;
          });
        } else {
          this.activity = "idle";
          this.turnStartedAt = 0;
          this.turnChunks = [];
          this.inactiveSince = Date.now();
          this.resolveTurnDone?.();
          this.resolveTurnDone = null;
        }
        this.params.onStatus(status);
      },
      onTranscript: (messages) => this.params.onTranscript(messages),
      onChunk: (chunk) => this.deliver(chunk),
    });
  }

  updateCallbacks(params: AcquireParams): void {
    this.params = {
      ...this.params,
      onStatus: params.onStatus,
      onTranscript: params.onTranscript,
    };
  }

  handle(reused: boolean): WarmSessionHandle {
    return {
      reused,
      attach: (sub) => this.attach(sub),
      detach: (sub) => this.detach(sub),
      sendMessage: (text) => this.sendMessage(text),
      respondToPermission: (requestId, optionId) =>
        this.bridge.respondToPermission(requestId, optionId),
      getPendingPermissionIds: () => this.bridge.getPendingPermissionIds(),
    };
  }

  async open(): Promise<void> {
    const stream = await this.bridge.openSession({
      cwd: this.params.cwd,
      openingPrompt: this.params.openingPrompt,
      history: this.params.history,
    });
    void this.drain(stream);
  }

  isIdleDetached(): boolean {
    return this.activity === "idle" && this.subscriber === null;
  }

  isAiWorking(): boolean {
    return this.activity === "ai-working";
  }

  whenIdle(): Promise<void> {
    if (this.activity === "idle") return Promise.resolve();
    return this.turnDone;
  }

  kill(): void {
    this.subscriber = null;
    this.bridge.close();
  }

  private attach(subscriber: ChunkSubscriber): void {
    this.subscriber = subscriber;
    for (const chunk of this.turnChunks) {
      subscriber.onChunk(chunk);
    }
  }

  private detach(subscriber: ChunkSubscriber): void {
    if (this.subscriber !== subscriber) return;
    this.subscriber = null;
    if (this.activity === "idle") {
      this.inactiveSince = Date.now();
    }
  }

  private async sendMessage(text: string): Promise<void> {
    const stream = await this.bridge.sendMessage(text);
    await this.drain(stream);
  }

  /** Drain the turn iterable; delivery happens synchronously via onChunk. */
  private async drain(stream: AsyncIterable<UIMessageChunk>): Promise<void> {
    for await (const _chunk of stream) {
      // chunks already delivered through AcpBridge onChunk
    }
  }

  private deliver(chunk: UIMessageChunk): void {
    this.turnChunks.push(chunk);
    if (this.subscriber) {
      this.subscriber.onChunk(chunk);
      return;
    }
    if (isPermissionChunk(chunk)) {
      this.params.onStatus("needs-user");
    }
  }
}

function isPermissionChunk(chunk: UIMessageChunk): boolean {
  return (chunk as { type?: string }).type === "data-permission";
}
