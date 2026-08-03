import type { UIMessage } from "ai";
import type { ChatAttachment, PromptCapabilities } from "../../shared/chat-ws.js";
import {
  AcpBridge,
  type AcpLiveCallbacks,
  type ChunkSubscriber,
  type InteractivePermissionPolicy,
  type SpawnAcp,
} from "./chat.js";
import type { ChatSessionId } from "./chat-session.js";

export type { ChunkSubscriber };

/** Minimal seam for last-connection-wins — ChatConnection implements this. */
export interface DisplaceableConnection {
  displace(reason: string): void;
}

export interface ColdAcquireParams {
  spawn: SpawnAcp;
  cwd: string;
  /** Null skips the auto opening turn when history is empty. */
  openingPrompt: string | null;
  history: UIMessage[];
  onStatus: AcpLiveCallbacks["onStatus"];
  onTranscript: AcpLiveCallbacks["onTranscript"];
  onTurnComplete?: AcpLiveCallbacks["onTurnComplete"];
  frameUserMessage?: AcpLiveCallbacks["frameUserMessage"];
  /** Spec (and future) live chats: Cursor-like auto-approve. */
  interactivePermissionPolicy?: InteractivePermissionPolicy;
  /** Pin via `agent --model`; omit/null = CLI default. */
  model?: string | null;
}

/** Cap on live ACP bridges across all chat sessions (issue #24). */
export const MAX_LIVE_SESSIONS = 5;

export interface WarmSessionHandle {
  reused: boolean;
  bridge: AcpBridge;
  attach(subscriber: ChunkSubscriber): void;
  detach(subscriber: ChunkSubscriber): void;
  /** Send a user message; chunks arrive via attach / onChunk buffering. */
  sendMessage(
    text: string,
    opts?: { liveDraftBody?: string; attachments?: ChatAttachment[] },
  ): Promise<void>;
  respondToPermission(requestId: string, optionId: string): void;
  /** Abort the in-flight ACP prompt turn. */
  cancelTurn(): void;
  getPendingPermissionIds(): string[];
  getPromptCapabilities(): PromptCapabilities;
}

/**
 * Writer slot + warm AcpBridge map (cap + eviction).
 * Keys are opaque server-built ChatSession ids (`card:…` / later `thread:…`).
 * WebSocket connections subscribe; close detaches without killing the bridge.
 */
export class ChatSessionRegistry {
  private readonly active = new Map<string, DisplaceableConnection>();
  private readonly warm = new Map<string, AcpBridge>();
  /** Model id pinned when each warm bridge was spawned (`null` = CLI default). */
  private readonly warmModel = new Map<string, string | null>();
  private admitChain: Promise<void> = Promise.resolve();

  get(id: ChatSessionId): DisplaceableConnection | undefined {
    return this.active.get(id);
  }

  hasWarm(id: ChatSessionId): boolean {
    return this.warm.has(id);
  }

  isAiWorking(id: ChatSessionId): boolean {
    return this.warm.get(id)?.isAiWorking() ?? false;
  }

  claim(id: ChatSessionId, connection: DisplaceableConnection): void {
    const previous = this.active.get(id);
    if (previous && previous !== connection) {
      previous.displace("session continued elsewhere");
    }
    this.active.set(id, connection);
  }

  release(id: ChatSessionId, connection: DisplaceableConnection): void {
    if (this.active.get(id) === connection) {
      this.active.delete(id);
    }
  }

  close(id: ChatSessionId, reason: string): void {
    const conn = this.active.get(id);
    if (conn) {
      conn.displace(reason);
      this.active.delete(id);
    }
    const bridge = this.warm.get(id);
    if (bridge) {
      bridge.close();
      this.warm.delete(id);
      this.warmModel.delete(id);
    }
  }

  async acquire(
    id: ChatSessionId,
    params: ColdAcquireParams,
  ): Promise<WarmSessionHandle> {
    const requestedModel = normalizeModel(params.model);
    const existing = this.warm.get(id);
    if (existing) {
      if (this.warmModel.get(id) !== requestedModel) {
        this.close(id, "model changed");
      } else {
        existing.setLiveCallbacks({
          onStatus: params.onStatus,
          onTranscript: params.onTranscript,
          onTurnComplete: params.onTurnComplete,
          frameUserMessage: params.frameUserMessage,
        });
        return this.handleFor(existing, true);
      }
    }

    return this.withAdmitLock(async () => {
      const again = this.warm.get(id);
      if (again) {
        if (this.warmModel.get(id) !== requestedModel) {
          this.close(id, "model changed");
        } else {
          again.setLiveCallbacks({
            onStatus: params.onStatus,
            onTranscript: params.onTranscript,
            onTurnComplete: params.onTurnComplete,
            frameUserMessage: params.frameUserMessage,
          });
          return this.handleFor(again, true);
        }
      }
      await this.ensureCapacity();
      const bridge = new AcpBridge({
        spawn: params.spawn,
        onStatus: params.onStatus,
        onTranscript: params.onTranscript,
        onTurnComplete: params.onTurnComplete,
        frameUserMessage: params.frameUserMessage,
      });
      this.warm.set(id, bridge);
      this.warmModel.set(id, requestedModel);
      try {
        await bridge.openSession({
          cwd: params.cwd,
          openingPrompt: params.openingPrompt,
          history: params.history,
          interactivePermissionPolicy: params.interactivePermissionPolicy,
          model: requestedModel,
        });
      } catch (err) {
        this.warm.delete(id);
        this.warmModel.delete(id);
        throw err;
      }
      return this.handleFor(bridge, false);
    });
  }

  private handleFor(bridge: AcpBridge, reused: boolean): WarmSessionHandle {
    return {
      reused,
      bridge,
      attach: (sub) => bridge.attach(sub),
      detach: (sub) => bridge.detach(sub),
      sendMessage: (text, opts) => bridge.sendMessage(text, opts),
      respondToPermission: (requestId, optionId) =>
        bridge.respondToPermission(requestId, optionId),
      cancelTurn: () => bridge.cancelTurn(),
      getPendingPermissionIds: () => bridge.getPendingPermissionIds(),
      getPromptCapabilities: () => bridge.getPromptCapabilities(),
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
    this.warmModel.delete(id);
  }
}

function normalizeModel(model?: string | null): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}
