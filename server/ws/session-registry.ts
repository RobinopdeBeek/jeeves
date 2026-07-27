import type { UIMessage } from "ai";
import type { StepKey } from "../pipelines.js";
import {
  AcpBridge,
  type AcpLiveCallbacks,
  type ChunkSubscriber,
  type SpawnAcp,
} from "./chat.js";

export type { ChunkSubscriber };

export interface SessionKey {
  cardId: string;
  stepKey: StepKey;
  round: number;
}

/** Minimal seam for last-connection-wins — ChatConnection implements this. */
export interface DisplaceableConnection {
  displace(reason: string): void;
}

export interface ColdAcquireParams {
  spawn: SpawnAcp;
  cwd: string;
  openingPrompt: string;
  history: UIMessage[];
  onStatus: AcpLiveCallbacks["onStatus"];
  onTranscript: AcpLiveCallbacks["onTranscript"];
}

/** Cap on live ACP bridges across all chat steps (issue #24). */
export const MAX_LIVE_SESSIONS = 5;

export function sessionKeyString(key: SessionKey): string {
  return `${key.cardId}:${key.stepKey}:${key.round}`;
}

export interface WarmSessionHandle {
  reused: boolean;
  bridge: AcpBridge;
  attach(subscriber: ChunkSubscriber): void;
  detach(subscriber: ChunkSubscriber): void;
  sendMessage(text: string): Promise<void>;
  respondToPermission(requestId: string, optionId: string): void;
  getPendingPermissionIds(): string[];
}

/**
 * Writer slot + warm AcpBridge map (cap + eviction).
 * WebSocket connections subscribe; close detaches without killing the bridge.
 */
export class ChatSessionRegistry {
  private readonly active = new Map<string, DisplaceableConnection>();
  private readonly warm = new Map<string, AcpBridge>();
  private admitChain: Promise<void> = Promise.resolve();

  get(key: SessionKey): DisplaceableConnection | undefined {
    return this.active.get(sessionKeyString(key));
  }

  hasWarm(key: SessionKey): boolean {
    return this.warm.has(sessionKeyString(key));
  }

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

  close(key: SessionKey, reason: string): void {
    const id = sessionKeyString(key);
    const conn = this.active.get(id);
    if (conn) {
      conn.displace(reason);
      this.active.delete(id);
    }
    const bridge = this.warm.get(id);
    if (bridge) {
      bridge.close();
      this.warm.delete(id);
    }
  }

  async acquire(key: SessionKey, params: ColdAcquireParams): Promise<WarmSessionHandle> {
    const id = sessionKeyString(key);
    const existing = this.warm.get(id);
    if (existing) {
      existing.setLiveCallbacks({
        onStatus: params.onStatus,
        onTranscript: params.onTranscript,
      });
      return this.handleFor(existing, true);
    }

    return this.withAdmitLock(async () => {
      const again = this.warm.get(id);
      if (again) {
        again.setLiveCallbacks({
          onStatus: params.onStatus,
          onTranscript: params.onTranscript,
        });
        return this.handleFor(again, true);
      }
      await this.ensureCapacity();
      const bridge = new AcpBridge({
        spawn: params.spawn,
        onStatus: params.onStatus,
        onTranscript: params.onTranscript,
      });
      this.warm.set(id, bridge);
      await bridge.openSession({
        cwd: params.cwd,
        openingPrompt: params.openingPrompt,
        history: params.history,
      });
      return this.handleFor(bridge, false);
    });
  }

  private handleFor(bridge: AcpBridge, reused: boolean): WarmSessionHandle {
    return {
      reused,
      bridge,
      attach: (sub) => bridge.attach(sub),
      detach: (sub) => bridge.detach(sub),
      sendMessage: (text) => bridge.sendMessage(text),
      respondToPermission: (requestId, optionId) =>
        bridge.respondToPermission(requestId, optionId),
      getPendingPermissionIds: () => bridge.getPendingPermissionIds(),
    };
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

    const idleDetached = [...this.warm.entries()]
      .filter(([, b]) => b.isIdleDetached())
      .sort((a, b) => a[1].inactiveSince - b[1].inactiveSince);
    if (idleDetached.length > 0) {
      const [evictId, bridge] = idleDetached[0]!;
      this.evictWarm(evictId, bridge, "session evicted for capacity");
      return;
    }

    const idleAttached = [...this.warm.entries()]
      .filter(([, b]) => !b.isAiWorking())
      .sort((a, b) => a[1].inactiveSince - b[1].inactiveSince);
    if (idleAttached.length > 0) {
      const [evictId, bridge] = idleAttached[0]!;
      this.evictWarm(evictId, bridge, "session evicted for capacity");
      return;
    }

    const busy = [...this.warm.entries()].sort(
      (a, b) => a[1].turnStartedAt - b[1].turnStartedAt,
    );
    const [evictId, bridge] = busy[0]!;
    await bridge.whenIdle();
    if (this.warm.get(evictId) === bridge) {
      this.evictWarm(evictId, bridge, "session evicted for capacity");
    }
    if (this.warm.size >= MAX_LIVE_SESSIONS) {
      await this.ensureCapacity();
    }
  }

  private evictWarm(id: string, bridge: AcpBridge, reason: string): void {
    const conn = this.active.get(id);
    if (conn) {
      conn.displace(reason);
      this.active.delete(id);
    }
    bridge.close();
    this.warm.delete(id);
  }
}
