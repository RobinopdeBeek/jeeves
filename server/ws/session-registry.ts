import type { UIMessage } from "ai";
import type { ChatAttachment, PromptCapabilities } from "../../shared/chat-ws.js";
import { recordModelCatalog, resolveModelValue } from "../models/list-models.js";
import {
  AcpBridge,
  type AdoptSessionOptions,
  type ChunkSubscriber,
  type SpawnAcp,
} from "./chat.js";
import type { ChatSession, ChatSessionId } from "./chat-session.js";

export type { ChunkSubscriber };

/** Minimal seam for last-connection-wins — ChatConnection implements this. */
export interface DisplaceableConnection {
  displace(reason: string): void;
}

/** Cap on live ACP processes across all chat sessions, spares included (issue #24). */
export const MAX_LIVE_SESSIONS = 5;

/** Reap a spare nobody claimed rather than paying for it all day. */
const SPARE_IDLE_TTL_MS = 10 * 60_000;
const SPARE_REAP_INTERVAL_MS = 60_000;

const CAPACITY_REASON = "session evicted for capacity";

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

/** A handshaked (or handshaking) process bound to a cwd, waiting for a claimant. */
interface SpareEntry {
  bridge: AcpBridge;
  /** Settles when the handshake lands or fails; never rejects. */
  done: Promise<void>;
  /** False while the handshake is still in flight. */
  ready: boolean;
}

/**
 * Writer slot + warm AcpBridge map (cap + eviction) + spare pool.
 * Keys are opaque server-built ChatSession ids (`card:…` / `thread:…`).
 * Acquire takes a resolved ChatSession — no ColdAcquireParams remapping.
 */
export class ChatSessionRegistry {
  private readonly active = new Map<string, DisplaceableConnection>();
  /** Only bridges whose ACP handshake has completed — safe to send into. */
  private readonly warm = new Map<string, AcpBridge>();
  /** Handshakes in flight, so concurrent acquires wait instead of racing. */
  private readonly opening = new Map<
    string,
    { bridge: AcpBridge; done: Promise<unknown> }
  >();
  /**
   * Pre-warmed processes keyed by cwd only — every process is model-agnostic,
   * so one spare serves any session in that checkout.
   */
  private readonly spares = new Map<string, SpareEntry>();
  private reaper: ReturnType<typeof setInterval> | null = null;
  private admitChain: Promise<void> = Promise.resolve();

  get(id: ChatSessionId): DisplaceableConnection | undefined {
    return this.active.get(id);
  }

  hasWarm(id: ChatSessionId): boolean {
    return this.warm.has(id);
  }

  hasSpare(cwd: string): boolean {
    return this.spares.has(cwd);
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
    }
    // Abandon a handshake still in flight (e.g. rewind mid-spawn) so the next
    // acquire starts fresh instead of waiting out the old spawn.
    const pending = this.opening.get(id);
    if (pending) {
      this.opening.delete(id);
      pending.bridge.close();
    }
  }

  /**
   * Warm a spare `agent acp` for `cwd` so the next session there skips the
   * ~5.5s handshake. Idempotent per cwd (a React StrictMode double-mount must
   * not spawn two), and never evicts: a speculative process must not displace a
   * session a user owns.
   */
  prewarm(cwd: string, spawn: SpawnAcp): void {
    if (this.spares.has(cwd)) return;
    if (this.liveCount() >= MAX_LIVE_SESSIONS) return;

    const bridge = new AcpBridge({ spawn });
    const entry: SpareEntry = { bridge, ready: false, done: Promise.resolve() };
    entry.done = bridge
      .openSession({ cwd, openingPrompt: null, history: [] })
      .then(() => {
        if (this.spares.get(cwd) !== entry) {
          // Evicted or reaped while handshaking.
          bridge.close();
          return;
        }
        entry.ready = true;
        // Age the spare from readiness, so LRU compares like with like.
        bridge.inactiveSince = Date.now();
        recordModelCatalog(bridge.getModelOption());
        this.startSpareReaper();
      })
      .catch((err: unknown) => {
        if (this.spares.get(cwd) === entry) this.spares.delete(cwd);
        bridge.close();
        console.error(
          `spare ACP session for ${cwd} failed to warm: ${errorMessage(err)}`,
        );
      });
    this.spares.set(cwd, entry);
    trackSparesForShutdown(this);
  }

  /** Apply a thread's pinned model to its live session, with no respawn. */
  async setModel(id: ChatSessionId, model: string | null): Promise<void> {
    const bridge = this.warm.get(id);
    if (!bridge) return;
    const value = this.resolveModelFor(bridge, model);
    if (value == null) return;
    await bridge.setModelValue(value);
  }

  /** Kill every spare (process shutdown) — no orphan `agent acp` may survive. */
  closeSpares(): void {
    for (const entry of [...this.spares.values()]) {
      entry.bridge.close();
    }
    this.spares.clear();
    this.stopSpareReaper();
    untrackSparesForShutdown(this);
  }

  async acquire(
    session: ChatSession,
    opts: { spawn: SpawnAcp },
  ): Promise<WarmSessionHandle> {
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
      onModelChanged: session.onModelChanged,
    });

    // A handshake already in flight owns this id. Wait for it rather than
    // handing back a bridge whose ACP session id is still null — that would
    // let the client send into a session that does not exist yet.
    for (;;) {
      const existing = this.warm.get(id);
      if (existing) {
        existing.setLiveCallbacks(wireLive());
        return this.handleFor(existing, true);
      }
      const inFlight = this.opening.get(id);
      if (!inFlight) break;
      await inFlight.done.catch(() => undefined);
    }

    return this.withAdmitLock(async () => {
      const again = this.warm.get(id);
      if (again) {
        again.setLiveCallbacks(wireLive());
        return this.handleFor(again, true);
      }

      session.assertMutable();
      const adoptOptions: AdoptSessionOptions = {
        openingPrompt: session.openingPrompt,
        history: session.loadTranscript(),
        interactivePermissionPolicy: session.interactivePermissionPolicy,
      };

      const spare = await this.claimSpare(session.cwd);
      if (spare) {
        spare.setLiveCallbacks(wireLive());
        await this.applyModel(spare, session.model);
        spare.adopt(adoptOptions);
        this.warm.set(id, spare);
        // Keep one ready for the next chat in this checkout.
        this.prewarm(session.cwd, opts.spawn);
        return this.handleFor(spare, false);
      }

      await this.ensureCapacity();
      const bridge = new AcpBridge({ spawn: opts.spawn, ...wireLive() });
      const entry = {
        bridge,
        done: bridge.openSession({
          cwd: session.cwd,
          openingPrompt: null,
          history: [],
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
      recordModelCatalog(bridge.getModelOption());
      await this.applyModel(bridge, session.model);
      bridge.adopt(adoptOptions);
      this.warm.set(id, bridge);
      return this.handleFor(bridge, false);
    });
  }

  /**
   * Take the spare for `cwd`, waiting out a handshake that is still in flight
   * (the process already exists — spawning a second one would just double the
   * cost). Null when there is none, or it died before we got to it.
   */
  private async claimSpare(cwd: string): Promise<AcpBridge | null> {
    const entry = this.spares.get(cwd);
    if (!entry) return null;
    await entry.done;
    if (this.spares.get(cwd) !== entry || !entry.ready) return null;
    this.spares.delete(cwd);
    this.stopSpareReaperWhenEmpty();
    // Nobody was watching this process, so it may have died unnoticed while it
    // waited. Fall through to a cold spawn rather than adopting a corpse.
    if (!entry.bridge.hasOpenSession()) {
      entry.bridge.close();
      return null;
    }
    return entry.bridge;
  }

  private resolveModelFor(
    bridge: AcpBridge,
    model: string | null | undefined,
  ): string | null {
    const option = bridge.getModelOption();
    if (!option) return null;
    const values = (option.options ?? []).map((o) => o.value);
    const value = resolveModelValue(model, values);
    return value === bridge.getCurrentModelValue() ? null : value;
  }

  /**
   * Pin the session's model on a handshaked bridge. A failure here leaves the
   * session on the agent's default rather than failing the whole open.
   */
  private async applyModel(
    bridge: AcpBridge,
    model: string | null | undefined,
  ): Promise<void> {
    const value = this.resolveModelFor(bridge, model);
    if (value == null) return;
    try {
      await bridge.setModelValue(value);
    } catch (err) {
      console.error(`could not select model ${value}: ${errorMessage(err)}`);
    }
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

  private liveCount(): number {
    return this.warm.size + this.spares.size;
  }

  private async ensureCapacity(): Promise<void> {
    if (this.liveCount() < MAX_LIVE_SESSIONS) return;

    // Tier 1, least-recently-used first. A spare is idle and detached by
    // definition, so it belongs in this tier and is evicted only when it is
    // genuinely the stalest process — no special-casing either way.
    const idleDetached = [
      ...[...this.warm.entries()]
        .filter(([, bridge]) => bridge.isIdleDetached())
        .map(([id, bridge]) => ({
          inactiveSince: bridge.inactiveSince,
          evict: () => this.evictWarm(id, bridge, CAPACITY_REASON),
        })),
      ...[...this.spares.entries()].map(([cwd, entry]) => ({
        inactiveSince: entry.bridge.inactiveSince,
        evict: () => this.discardSpare(cwd),
      })),
    ].sort((a, b) => a.inactiveSince - b.inactiveSince);
    if (idleDetached.length > 0) {
      idleDetached[0]!.evict();
      return;
    }

    const idleAttached = [...this.warm.entries()]
      .filter(([, b]) => !b.isAiWorking())
      .sort((a, b) => a[1].inactiveSince - b[1].inactiveSince);
    if (idleAttached.length > 0) {
      const [evictId, bridge] = idleAttached[0]!;
      this.evictWarm(evictId, bridge, CAPACITY_REASON);
      return;
    }

    const busy = [...this.warm.entries()].sort(
      (a, b) => a[1].turnStartedAt - b[1].turnStartedAt,
    );
    const [evictId, bridge] = busy[0]!;
    await bridge.whenIdle();
    if (this.warm.get(evictId) === bridge) {
      this.evictWarm(evictId, bridge, CAPACITY_REASON);
    }
    if (this.liveCount() >= MAX_LIVE_SESSIONS) {
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

  private discardSpare(cwd: string): void {
    const entry = this.spares.get(cwd);
    if (!entry) return;
    this.spares.delete(cwd);
    entry.bridge.close();
    this.stopSpareReaperWhenEmpty();
  }

  private startSpareReaper(): void {
    if (this.reaper != null) return;
    this.reaper = setInterval(
      () => this.reapIdleSpares(),
      SPARE_REAP_INTERVAL_MS,
    );
    // Never hold the process (or a test run) open for a speculative process.
    this.reaper.unref?.();
  }

  private reapIdleSpares(): void {
    const cutoff = Date.now() - SPARE_IDLE_TTL_MS;
    for (const [cwd, entry] of [...this.spares]) {
      if (!entry.ready) continue;
      if (entry.bridge.inactiveSince <= cutoff || !entry.bridge.hasOpenSession()) {
        this.discardSpare(cwd);
      }
    }
    this.stopSpareReaperWhenEmpty();
  }

  private stopSpareReaperWhenEmpty(): void {
    if (this.spares.size > 0) return;
    this.stopSpareReaper();
    untrackSparesForShutdown(this);
  }

  private stopSpareReaper(): void {
    if (this.reaper == null) return;
    clearInterval(this.reaper);
    this.reaper = null;
  }
}

/**
 * Spares are processes nobody is watching, so an abrupt exit must still kill
 * them. One process-level hook for the whole module; registries opt in only
 * once they actually own a spare.
 */
const registriesWithSpares = new Set<ChatSessionRegistry>();
let shutdownHookInstalled = false;

function trackSparesForShutdown(registry: ChatSessionRegistry): void {
  registriesWithSpares.add(registry);
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  process.once("exit", () => {
    for (const tracked of [...registriesWithSpares]) tracked.closeSpares();
  });
}

function untrackSparesForShutdown(registry: ChatSessionRegistry): void {
  registriesWithSpares.delete(registry);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
