import type { UIMessage } from "ai";
import type { ChatAttachment, PromptCapabilities } from "../../shared/chat-ws.js";
import {
  AcpBridge,
  type ChunkSubscriber,
  type SpawnAcp,
} from "./chat.js";
import type { ChatSession, ChatSessionId } from "./chat-session.js";

export type { ChunkSubscriber };

/** Minimal seam for last-connection-wins — ChatConnection implements this. */
export interface DisplaceableConnection {
  displace(reason: string): void;
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
 * Keys are opaque server-built ChatSession ids (`card:…` / `thread:…`).
 * Acquire takes a resolved ChatSession — no ColdAcquireParams remapping.
 */
export class ChatSessionRegistry {
  private readonly active = new Map<string, DisplaceableConnection>();
  /** Only bridges whose ACP handshake has completed — safe to send into. */
  private readonly warm = new Map<string, AcpBridge>();
  /** Model id pinned when each warm bridge was spawned (`null` = CLI default). */
  private readonly warmModel = new Map<string, string | null>();
  /** Handshakes in flight, so concurrent acquires wait instead of racing. */
  private readonly opening = new Map<
    string,
    { bridge: AcpBridge; done: Promise<unknown> }
  >();
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
    // Abandon a handshake still in flight (e.g. model changed mid-spawn) so
    // the next acquire starts fresh instead of waiting out the old spawn.
    const pending = this.opening.get(id);
    if (pending) {
      this.opening.delete(id);
      pending.bridge.close();
    }
  }

  async acquire(
    session: ChatSession,
    opts: { spawn: SpawnAcp },
  ): Promise<WarmSessionHandle> {
    const requestedModel = normalizeModel(session.model);
    const id = session.id;
    const wireLive = () => ({
      onStatus: (status: "ai-working" | "needs-user") =>
        session.notifyStatus(status),
      onTranscript: (messages: UIMessage[]) => {
        session.assertMutable();
        session.saveTranscript(messages);
      },
      onTurnComplete: session.onTurnComplete,
      frameUserMessage: session.frameUserMessage,
    });

    // A handshake already in flight owns this id. Wait for it rather than
    // handing back a bridge whose ACP session id is still null — that would
    // let the client send into a session that does not exist yet.
    for (;;) {
      const existing = this.warm.get(id);
      if (existing) {
        if (this.warmModel.get(id) === requestedModel) {
          existing.setLiveCallbacks(wireLive());
          return this.handleFor(existing, true);
        }
        this.discardWarm(id);
        break;
      }
      const inFlight = this.opening.get(id);
      if (!inFlight) break;
      await inFlight.done.catch(() => undefined);
    }

    return this.withAdmitLock(async () => {
      const again = this.warm.get(id);
      if (again) {
        if (this.warmModel.get(id) !== requestedModel) {
          this.discardWarm(id);
        } else {
          again.setLiveCallbacks(wireLive());
          return this.handleFor(again, true);
        }
      }
      await this.ensureCapacity();
      const live = wireLive();
      const bridge = new AcpBridge({
        spawn: opts.spawn,
        onStatus: live.onStatus,
        onTranscript: live.onTranscript,
        onTurnComplete: live.onTurnComplete,
        frameUserMessage: live.frameUserMessage,
      });
      session.assertMutable();
      const history = session.loadTranscript();
      const entry = {
        bridge,
        done: bridge.openSession({
          cwd: session.cwd,
          openingPrompt: session.openingPrompt,
          history,
          interactivePermissionPolicy: session.interactivePermissionPolicy,
          model: requestedModel,
        }),
      };
      this.opening.set(id, entry);
      try {
        await entry.done;
      } catch (err) {
        // Never leave an orphaned `agent acp` behind on a failed handshake.
        bridge.close();
        throw err;
      } finally {
        if (this.opening.get(id) === entry) this.opening.delete(id);
      }
      this.warm.set(id, bridge);
      this.warmModel.set(id, requestedModel);
      return this.handleFor(bridge, false);
    });
  }

  /**
   * Retire a warm bridge without displacing anyone. The connection asking for
   * a different model is the active one, so `close` here would kick it out of
   * the session it is in the middle of opening.
   */
  private discardWarm(id: string): void {
    this.warm.get(id)?.close();
    this.warm.delete(id);
    this.warmModel.delete(id);
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
