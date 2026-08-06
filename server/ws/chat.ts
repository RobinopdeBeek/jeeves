import { nanoid } from "nanoid";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  ChatAttachment,
  PermissionOptionPart,
  PermissionRequestData,
  PromptCapabilities,
} from "../../shared/chat-ws.js";
import {
  assertAttachmentsAllowed,
  EMPTY_PROMPT_CAPABILITIES,
  normalizePromptCapabilities,
} from "../../shared/prompt-capabilities.js";
import {
  buildPromptContentBlocks,
  buildSeedPromptContentBlocks,
  userMessageParts,
} from "./acp-content.js";
import {
  decideHeadlessPermission,
  decideInteractivePermission,
} from "./acp-permissions.js";

export type { PermissionOptionPart, PermissionRequestData };
export {
  decideHeadlessPermission,
  decideInteractivePermission,
} from "./acp-permissions.js";

/** How the agent process ended, with whatever it said on stderr. */
export interface AcpExit {
  code: number | null;
  signal: string | null;
  /** Tail of the child's stderr — the only diagnostic a crashed CLI leaves. */
  stderr: string;
}

/** Injected stdio boundary for `agent acp` (mocked in tests). */
export interface AcpProcess {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  /** Fired when the agent exits on its own (crash, auth abort, kill). */
  onExit?(handler: (exit: AcpExit) => void): void;
  kill(): void;
}

/**
 * Handshake RPCs must not hang forever: a wedged CLI would otherwise strand
 * the composer on "Starting agent session…" with nothing to report.
 */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/**
 * `authenticate` starts an interactive browser login. A background server can
 * never complete one, so cap the wait and turn it into actionable advice.
 */
const AUTHENTICATE_TIMEOUT_MS = 15_000;
/** Measured ~850ms against the real CLI; generous headroom, still bounded. */
const SET_CONFIG_OPTION_TIMEOUT_MS = 30_000;

/** The agent has no usable credentials; no amount of retrying helps. */
export class AcpAuthError extends Error {
  constructor(detail: string) {
    super(
      `Cursor Agent CLI is not authenticated (${detail}). Set CURSOR_API_KEY in ` +
        ".env or run `agent login`, then restart Jeeves.",
    );
    this.name = "AcpAuthError";
  }
}

export type SpawnAcp = (cwd: string) => AcpProcess | Promise<AcpProcess>;

/** ACP session config option (`session/new` → `configOptions`). */
export interface AcpSessionConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string | null;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

export interface AcpLiveCallbacks {
  onStatus: (status: "ai-working" | "needs-user") => void;
  onTranscript: (messages: UIMessage[]) => void;
  /** Fired when a prompt turn reaches idle (not mid-turn detached permission). */
  onTurnComplete?: () => void;
  /** Profile-owned framing for live draft body → agent prompt. */
  frameUserMessage?: (userText: string, liveDraftBody: string) => string;
  /** The agent switched model on its own (rate limit, fallback). */
  onModelChanged?: (value: string) => void;
  /**
   * Rewrite live `data:` attachments to sidecar pointers before transcript
   * persist / ACP prompt (ADR 0017). Omit in unit tests that keep data URLs.
   */
  persistAttachments?: (
    attachments: ChatAttachment[],
  ) => ChatAttachment[];
  /** Resolve pointer or data: URL → base64 for ACP ContentBlocks. */
  resolveAttachmentBytes?: (att: ChatAttachment) => {
    mimeType: string;
    data: string;
  };
}

/**
 * Session-scoped state a real chat needs on top of the ACP handshake.
 * Applied by {@link AcpBridge.adopt}, so a pre-warmed spare can be claimed.
 */
export interface AdoptSessionOptions {
  /**
   * Injected when history is empty — drives the agent's opening question.
   * Null skips the auto turn (Project Chat warm-and-user-first).
   */
  openingPrompt: string | null;
  history?: UIMessage[];
  /**
   * Live chat: `cursor-like` auto-approves reads/shell/exchange writes;
   * `project-chat` auto-approves reads only (shell + file writes prompt).
   */
  interactivePermissionPolicy?: InteractivePermissionPolicy;
}

export interface OpenSessionOptions extends AdoptSessionOptions {
  cwd: string;
}

/**
 * Headless permission policy for one-shot ACP runs (e.g. /to-spec).
 * Auto-approves reads/routine tools and project-store exchange writes;
 * rejects other writes and fails the run — never stalls on a permission UI.
 */
export type HeadlessPermissionPolicy = "cursor-like";

/**
 * Live chat permission policy:
 * - cursor-like: auto-approve reads/shell/exchange; prompt for other file writes
 * - project-chat: auto-approve reads only; prompt for shell and file writes
 */
export type InteractivePermissionPolicy = "cursor-like" | "project-chat";

export interface RunToCompletionOptions {
  cwd: string;
  prompt: string;
  permissionPolicy: HeadlessPermissionPolicy;
  /** Fail the run if the turn does not finish within this window. */
  timeoutMs?: number;
}

export class AcpHeadlessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpHeadlessError";
  }
}

/** Receives projected UIMessage chunks while attached to a warm session. */
export interface ChunkSubscriber {
  onChunk(chunk: UIMessageChunk): void;
}

type PermissionPart = {
  type: "data-permission";
  id: string;
  data: PermissionRequestData;
};

function isPermissionPart(p: UIMessage["parts"][number]): p is PermissionPart {
  return (p as { type?: string }).type === "data-permission";
}

function isPermissionChunk(chunk: UIMessageChunk): boolean {
  return (chunk as { type?: string }).type === "data-permission";
}

function permissionChunk(
  requestId: string,
  data: PermissionRequestData,
): UIMessageChunk {
  return { type: "data-permission", id: requestId, data } as UIMessageChunk;
}

/**
 * Long-lived ACP session: projects JSON-RPC into UIMessage chunks (push-only),
 * owns warm attach/catch-up buffering, and seeds resume context once.
 */
export class AcpBridge {
  private process: AcpProcess | null = null;
  private sessionId: string | null = null;
  private nextRpcId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void }
  >();
  private readonly pendingPermissions = new Map<string, number>();
  private messages: UIMessage[] = [];
  private currentTextId: string | null = null;
  private currentAssistant: UIMessage | null = null;
  /**
   * Set when a non-text session update (tool_call, thought, …) arrives mid-turn
   * so the next agent_message_chunk becomes a new text part instead of being
   * concatenated onto the previous sentence.
   */
  private textInterrupted = false;
  /** False until opening turn finishes or resume history is seeded into a prompt. */
  private contextSeeded = false;

  private subscriber: ChunkSubscriber | null = null;
  private turnChunks: UIMessageChunk[] = [];
  private activity: "idle" | "ai-working" = "idle";
  private turnDone: Promise<void> = Promise.resolve();
  private resolveTurnDone: (() => void) | null = null;
  /** Detached permission pending — board + streaming treat as needs-user. */
  private awaitingDetachedPermission = false;
  /** Epoch ms when the current turn started; 0 when idle. */
  turnStartedAt = 0;
  /** Epoch ms when we last became idle with no subscriber. */
  inactiveSince = Date.now();

  private live: AcpLiveCallbacks;
  /** When set, permission requests are resolved without a subscriber. */
  private headlessPolicy: HeadlessPermissionPolicy | null = null;
  private headlessFail: ((err: Error) => void) | null = null;
  /** Live Cursor-like auto-approve; prompt for non-exchange file writes. */
  private interactivePolicy: InteractivePermissionPolicy | null = null;
  /** Negotiated from initialize; omitted fields fail closed. */
  private promptCapabilities: PromptCapabilities = {
    ...EMPTY_PROMPT_CAPABILITIES,
  };
  /** `session/new` config options; the `model` selector drives live switching. */
  private modelOption: AcpSessionConfigOption | null = null;

  constructor(
    private readonly deps: { spawn: SpawnAcp } & Partial<AcpLiveCallbacks>,
  ) {
    this.live = {
      onStatus: deps.onStatus ?? (() => {}),
      onTranscript: deps.onTranscript ?? (() => {}),
      onTurnComplete: deps.onTurnComplete,
      frameUserMessage: deps.frameUserMessage,
      onModelChanged: deps.onModelChanged,
      persistAttachments: deps.persistAttachments,
      resolveAttachmentBytes: deps.resolveAttachmentBytes,
    };
  }

  setLiveCallbacks(callbacks: AcpLiveCallbacks): void {
    this.live = callbacks;
  }

  getMessages(): UIMessage[] {
    return this.messages;
  }

  getPromptCapabilities(): PromptCapabilities {
    return this.promptCapabilities;
  }

  /** The agent's `model` config selector, or null when it advertises none. */
  getModelOption(): AcpSessionConfigOption | null {
    return this.modelOption;
  }

  getCurrentModelValue(): string | null {
    return this.modelOption?.currentValue ?? null;
  }

  /**
   * Switch model in place via `session/set_config_option` (~850ms, keeps the
   * conversation). No-op when the session is already on `value`.
   */
  async setModelValue(value: string): Promise<void> {
    const option = this.modelOption;
    if (!option) throw new Error("agent does not advertise a model selector");
    if (option.currentValue === value) return;
    if (!this.sessionId) throw new Error("session not open");
    const result = (await this.rpc(
      "session/set_config_option",
      { sessionId: this.sessionId, configId: option.id, value },
      SET_CONFIG_OPTION_TIMEOUT_MS,
    )) as { configOptions?: unknown } | undefined;
    // The agent answers with the complete config state; fall back to the
    // requested value when it answers with nothing useful.
    const updated = findModelConfigOption(result?.configOptions);
    this.modelOption = updated ?? { ...option, currentValue: value };
  }

  /** True while the handshaked session still has a living process behind it. */
  hasOpenSession(): boolean {
    return this.sessionId != null && this.process != null;
  }

  getPendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()];
  }

  isIdleDetached(): boolean {
    return this.activity === "idle" && this.subscriber === null;
  }

  isAiWorking(): boolean {
    return this.activity === "ai-working" && !this.awaitingDetachedPermission;
  }

  whenIdle(): Promise<void> {
    if (this.activity === "idle") return Promise.resolve();
    return this.turnDone;
  }

  attach(subscriber: ChunkSubscriber): void {
    this.subscriber = subscriber;
    for (const chunk of this.turnChunks) {
      subscriber.onChunk(chunk);
    }
  }

  detach(subscriber: ChunkSubscriber): void {
    if (this.subscriber !== subscriber) return;
    this.subscriber = null;
    if (this.activity === "idle") {
      this.inactiveSince = Date.now();
    }
  }

  respondToPermission(requestId: string, optionId: string): void {
    const rpcId = this.pendingPermissions.get(requestId);
    if (rpcId == null) throw new Error(`unknown permission request: ${requestId}`);
    this.pendingPermissions.delete(requestId);

    this.respond(rpcId, {
      outcome: { outcome: "selected", optionId },
    });

    const part = this.findPermissionPart(requestId);
    if (part) {
      part.data = {
        ...part.data,
        status: "resolved",
        selectedOptionId: optionId,
      };
      this.pushChunk(permissionChunk(requestId, part.data));
    }
  }

  /**
   * Abort the in-flight prompt turn (Stop). Cancels pending permissions and
   * sends ACP `session/cancel`; the prompt RPC resolves with `cancelled`.
   */
  cancelTurn(): void {
    if (this.activity !== "ai-working" || !this.sessionId || !this.process) {
      return;
    }

    for (const [requestId, rpcId] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId);
      this.respond(rpcId, { outcome: { outcome: "cancelled" } });
      const part = this.findPermissionPart(requestId);
      if (part) {
        part.data = { ...part.data, status: "resolved" };
        this.pushChunk(permissionChunk(requestId, part.data));
      }
    }

    this.process.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      }) + "\n",
    );
  }

  /**
   * Spawn `agent acp` and run the handshake, then {@link adopt} the session
   * state. The process is model-agnostic — the model is a session config
   * option, applied after the handshake.
   */
  async openSession(options: OpenSessionOptions): Promise<void> {
    this.process = await this.deps.spawn(options.cwd);
    this.process.onLine((line) => this.handleLine(line));
    this.process.onExit?.((exit) => this.handleProcessExit(exit));

    const initResult = (await this.rpc(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Required before the agent will advertise session config options.
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "jeeves-acp-bridge", version: "0.1.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    )) as {
      agentCapabilities?: { promptCapabilities?: unknown };
    };
    this.promptCapabilities = normalizePromptCapabilities(
      initResult?.agentCapabilities?.promptCapabilities,
    );
    this.sessionId = await this.createAcpSession(options.cwd);

    this.adopt(options);
  }

  /**
   * Bind a handshaked session to one chat. Empty history + non-null
   * openingPrompt runs that turn; empty history + null openingPrompt stays
   * warm with no auto agent message; non-empty history loads messages and waits
   * for the first user send (seed-once).
   *
   * Touches no ACP state, so a pre-warmed spare can be claimed with this after
   * its handshake has already completed.
   */
  adopt(options: AdoptSessionOptions): void {
    if (!this.sessionId) throw new Error("session not open");
    this.messages = options.history ? [...options.history] : [];
    this.contextSeeded = this.messages.length === 0;
    this.interactivePolicy = options.interactivePermissionPolicy ?? null;

    if (this.messages.length === 0 && options.openingPrompt !== null) {
      this.contextSeeded = true;
      // Fire-and-forget so acquire can return and the client can attach mid-turn.
      void this.runPromptTurn(options.openingPrompt, { recordUser: false });
    }
  }

  /**
   * `session/new`, authenticating only when the agent says it must. Calling
   * `authenticate` up front opens an interactive browser login even for an
   * already-credentialed CLI, and that login never returns here.
   */
  private async createAcpSession(cwd: string): Promise<string> {
    try {
      return await this.newSession(cwd);
    } catch (err) {
      if (!isAuthRequired(err)) throw err;
      try {
        await this.rpc(
          "authenticate",
          { methodId: "cursor_login" },
          AUTHENTICATE_TIMEOUT_MS,
        );
        return await this.newSession(cwd);
      } catch {
        throw new AcpAuthError(rpcMessage(err));
      }
    }
  }

  private async newSession(cwd: string): Promise<string> {
    const created = (await this.rpc(
      "session/new",
      { cwd, mcpServers: [] },
      HANDSHAKE_TIMEOUT_MS,
    )) as { sessionId: string; configOptions?: unknown };
    this.modelOption = findModelConfigOption(created.configOptions);
    return created.sessionId;
  }

  /** Send a user message; chunks arrive via attach / onChunk buffering. */
  async sendMessage(
    text: string,
    opts?: { liveDraftBody?: string; attachments?: ChatAttachment[] },
  ): Promise<void> {
    if (!this.sessionId) throw new Error("session not open");
    const attachments = opts?.attachments ?? [];
    if (!text.trim() && attachments.length === 0) {
      throw new Error("Message must include text or at least one attachment.");
    }
    await this.runPromptTurn(text, {
      recordUser: true,
      liveDraftBody: opts?.liveDraftBody,
      attachments,
    });
  }

  /**
   * One-shot headless ACP turn: spawn, prompt, wait for idle, then kill.
   * Permissions follow `permissionPolicy` — never waits for a UI subscriber.
   */
  async runToCompletion(options: RunToCompletionOptions): Promise<void> {
    this.headlessPolicy = options.permissionPolicy;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const failPromise = new Promise<never>((_, reject) => {
      this.headlessFail = reject;
    });

    try {
      const work = (async () => {
        await this.openSession({
          cwd: options.cwd,
          openingPrompt: options.prompt,
          history: [],
        });
        await this.whenIdle();
      })();

      const raced =
        options.timeoutMs != null
          ? Promise.race([
              work,
              failPromise,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  timedOut = true;
                  reject(
                    new AcpHeadlessError(
                      `headless ACP run timed out after ${options.timeoutMs}ms`,
                    ),
                  );
                }, options.timeoutMs);
              }),
            ])
          : Promise.race([work, failPromise]);

      await raced;
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
      this.headlessPolicy = null;
      this.headlessFail = null;
      this.close();
      if (timedOut) {
        // close() already ran; error already thrown from race
      }
    }
  }

  close(): void {
    this.subscriber = null;
    this.pendingPermissions.clear();
    this.headlessPolicy = null;
    this.headlessFail = null;
    const process = this.process;
    this.process = null;
    this.sessionId = null;
    this.failPending(new Error("ACP session closed"));
    process?.kill();
  }

  /**
   * The agent died on its own. Everything waiting on it must fail now —
   * otherwise an open handshake or turn hangs for the life of the server.
   */
  private handleProcessExit(exit: AcpExit): void {
    if (!this.process) return;
    this.process = null;
    this.sessionId = null;

    const stderr = exit.stderr.trim();
    const how =
      exit.signal != null ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`;
    const err = new Error(
      `Cursor Agent CLI exited (${how})${stderr ? `: ${stderr}` : ""}`,
    );
    this.failPending(err);

    if (this.activity === "ai-working") {
      this.pushChunk({ type: "error", errorText: err.message });
      this.currentTextId = null;
      this.currentAssistant = null;
      this.endTurn();
    }
  }

  private failPending(err: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) waiter.reject(err);
  }

  private beginTurn(): void {
    this.activity = "ai-working";
    this.awaitingDetachedPermission = false;
    this.textInterrupted = false;
    this.turnStartedAt = Date.now();
    this.turnChunks = [];
    this.turnDone = new Promise((resolve) => {
      this.resolveTurnDone = resolve;
    });
    this.live.onStatus("ai-working");
  }

  /** Close the open text part and open a fresh one on the current assistant. */
  private rotateTextPart(): void {
    if (!this.currentTextId || !this.currentAssistant) return;
    this.pushChunk({ type: "text-end", id: this.currentTextId });
    const textId = nanoid(10);
    this.currentTextId = textId;
    this.currentAssistant.parts.push({ type: "text", text: "" });
    this.pushChunk({ type: "text-start", id: textId });
  }

  private lastTextPart(): { type: "text"; text: string } | undefined {
    if (!this.currentAssistant) return undefined;
    for (let i = this.currentAssistant.parts.length - 1; i >= 0; i--) {
      const part = this.currentAssistant.parts[i];
      if (part?.type === "text") return part;
    }
    return undefined;
  }

  private endTurn(opts?: { turnCompleteAlreadyRun?: boolean }): void {
    this.activity = "idle";
    this.awaitingDetachedPermission = false;
    this.turnStartedAt = 0;
    this.turnChunks = [];
    this.inactiveSince = Date.now();
    this.resolveTurnDone?.();
    this.resolveTurnDone = null;
    // Harvest Spec revisions before needs-user so the client can apply
    // while still locked, then unlock on the status frame.
    if (!opts?.turnCompleteAlreadyRun) {
      this.live.onTurnComplete?.();
    }
    this.live.onStatus("needs-user");
  }

  private async runPromptTurn(
    text: string,
    opts: {
      recordUser: boolean;
      liveDraftBody?: string;
      attachments?: ChatAttachment[];
    },
  ): Promise<void> {
    if (!this.sessionId || !this.process) throw new Error("session not open");

    let attachments = opts.attachments ?? [];
    // Fail closed before mutating transcript / starting the turn.
    if (opts.recordUser) {
      if (!text.trim() && attachments.length === 0) {
        throw new Error("Message must include text or at least one attachment.");
      }
      assertAttachmentsAllowed(attachments, this.promptCapabilities);
      if (this.live.persistAttachments && attachments.length > 0) {
        attachments = this.live.persistAttachments(attachments);
      }
    }

    this.beginTurn();

    if (opts.recordUser) {
      this.messages.push({
        id: nanoid(10),
        role: "user",
        parts: userMessageParts(text, attachments),
      });
    }

    const messageId = nanoid(10);
    const textId = nanoid(10);
    this.currentTextId = textId;
    this.currentAssistant = {
      id: messageId,
      role: "assistant",
      parts: [{ type: "text", text: "" }],
    };

    this.pushChunk({ type: "start", messageId });
    this.pushChunk({ type: "text-start", id: textId });

    // Live draft (if any) is agent-prompt context only — never stored in transcript.
    const agentText =
      opts.liveDraftBody != null && this.live.frameUserMessage
        ? this.live.frameUserMessage(text, opts.liveDraftBody)
        : text;

    const resolveBytes = this.live.resolveAttachmentBytes;
    let promptBlocks;
    if (opts.recordUser && !this.contextSeeded) {
      promptBlocks = buildSeedPromptContentBlocks({
        history: this.messages,
        latestText: agentText,
        latestAttachments: attachments,
        caps: this.promptCapabilities,
        resolveBytes,
      });
      this.contextSeeded = true;
    } else {
      promptBlocks = buildPromptContentBlocks({
        text: agentText,
        attachments: opts.recordUser ? attachments : [],
        caps: this.promptCapabilities,
        resolveBytes,
      });
    }

    try {
      const result = (await this.rpc("session/prompt", {
        sessionId: this.sessionId,
        prompt: promptBlocks,
      })) as { stopReason?: string } | undefined;
      const cancelled = result?.stopReason === "cancelled";
      if (this.currentTextId) {
        this.pushChunk({ type: "text-end", id: this.currentTextId });
      }
      if (this.currentAssistant) {
        this.messages.push(this.currentAssistant);
        this.currentAssistant = null;
      }
      this.currentTextId = null;
      this.live.onTranscript(this.messages);
      // Harvest before `finish` so `spec-revised` arrives while the client still
      // treats the turn as streaming (finish/markTurnDone unlocks the editor).
      // Skip harvest on cancel — a partial exchange write is not a committed tip.
      if (!cancelled) {
        this.live.onTurnComplete?.();
      }
      this.pushChunk({ type: "finish", finishReason: "stop" });
      this.endTurn({ turnCompleteAlreadyRun: true });
    } catch (err) {
      this.pushChunk({
        type: "error",
        errorText: err instanceof Error ? err.message : String(err),
      });
      this.currentTextId = null;
      this.currentAssistant = null;
      this.endTurn();
    }
  }

  private pushChunk(chunk: UIMessageChunk): void {
    this.turnChunks.push(chunk);
    if (this.subscriber) {
      this.subscriber.onChunk(chunk);
      return;
    }
    if (isPermissionChunk(chunk)) {
      this.awaitingDetachedPermission = true;
      this.live.onStatus("needs-user");
    }
  }

  private handleLine(line: string): void {
    let msg: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: unknown;
      params?: {
        update?: {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
          configOptions?: unknown;
        };
        toolCall?: { toolCallId?: string; title?: string };
        options?: Array<{ optionId?: string; name?: string; kind?: string }>;
      };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(rpcError(msg.error));
      else waiter.resolve(msg.result);
      return;
    }

    if (msg.method === "session/update") {
      const update = msg.params?.update;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string" &&
        this.currentTextId
      ) {
        if (this.textInterrupted) {
          this.textInterrupted = false;
          this.rotateTextPart();
        }
        const delta = update.content.text;
        const part = this.lastTextPart();
        if (part) part.text += delta;
        this.pushChunk({
          type: "text-delta",
          id: this.currentTextId,
          delta,
        });
      } else if (update?.sessionUpdate === "config_option_update") {
        // The agent may switch model on its own (rate limit, fallback).
        this.applyConfigOptionUpdate(update.configOptions);
      } else if (
        this.currentTextId &&
        (update?.sessionUpdate === "tool_call" ||
          update?.sessionUpdate === "agent_thought_chunk" ||
          update?.sessionUpdate === "agent_thought")
      ) {
        // Substantive gap — next message chunk is a new segment.
        // Ignore tool_call_update status noise so mid-sentence text stays one part.
        this.textInterrupted = true;
      }
      return;
    }

    if (msg.method === "session/request_permission" && msg.id != null) {
      if (this.currentTextId) this.textInterrupted = true;
      this.projectPermissionRequest(msg.id, msg.params);
    }
  }

  private applyConfigOptionUpdate(configOptions: unknown): void {
    const updated = findModelConfigOption(configOptions);
    if (!updated) return;
    const before = this.modelOption?.currentValue ?? null;
    this.modelOption = updated;
    const after = updated.currentValue ?? null;
    if (after != null && after !== before) this.live.onModelChanged?.(after);
  }

  private projectPermissionRequest(
    rpcId: number,
    params:
      | {
          toolCall?: { toolCallId?: string; title?: string };
          options?: Array<{ optionId?: string; name?: string; kind?: string }>;
        }
      | undefined,
  ): void {
    const requestId = String(rpcId);
    const options: PermissionOptionPart[] = (params?.options ?? [])
      .filter((o): o is { optionId: string; name: string; kind: string } =>
        typeof o.optionId === "string" &&
        typeof o.name === "string" &&
        typeof o.kind === "string",
      )
      .map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));

    const data: PermissionRequestData = {
      requestId,
      toolCallId: params?.toolCall?.toolCallId,
      title: params?.toolCall?.title,
      options,
      status: "pending",
    };

    this.pendingPermissions.set(requestId, rpcId);

    if (this.headlessPolicy != null) {
      const part: PermissionPart = {
        type: "data-permission",
        id: requestId,
        data,
      };
      if (this.currentAssistant) {
        this.currentAssistant.parts.push(part as UIMessage["parts"][number]);
      } else {
        this.currentAssistant = {
          id: nanoid(10),
          role: "assistant",
          parts: [part as UIMessage["parts"][number]],
        };
        this.pushChunk({ type: "start", messageId: this.currentAssistant.id });
      }
      this.pushChunk(permissionChunk(requestId, data));
      this.resolveHeadlessPermission(requestId, data);
      return;
    }

    if (this.interactivePolicy != null) {
      const decision = decideInteractivePermission(data, this.interactivePolicy);
      if (decision.action === "allow") {
        this.respondToPermission(requestId, decision.optionId);
        return;
      }
    }

    const part: PermissionPart = {
      type: "data-permission",
      id: requestId,
      data,
    };

    if (this.currentAssistant) {
      this.currentAssistant.parts.push(part as UIMessage["parts"][number]);
    } else {
      this.currentAssistant = {
        id: nanoid(10),
        role: "assistant",
        parts: [part as UIMessage["parts"][number]],
      };
      this.pushChunk({ type: "start", messageId: this.currentAssistant.id });
    }

    this.pushChunk(permissionChunk(requestId, data));
  }

  private resolveHeadlessPermission(
    requestId: string,
    data: PermissionRequestData,
  ): void {
    const decision = decideHeadlessPermission(data);
    if (decision.action === "allow") {
      this.respondToPermission(requestId, decision.optionId);
      return;
    }

    if (decision.optionId) {
      try {
        this.respondToPermission(requestId, decision.optionId);
      } catch {
        // Process may already be closing; still fail the run below.
      }
    } else {
      this.pendingPermissions.delete(requestId);
    }

    const err = new AcpHeadlessError(decision.reason);
    this.headlessFail?.(err);
  }

  private findPermissionPart(requestId: string): PermissionPart | undefined {
    const fromCurrent = this.currentAssistant?.parts.find(
      (p): p is PermissionPart => isPermissionPart(p) && p.id === requestId,
    );
    if (fromCurrent) return fromCurrent;

    for (const message of this.messages) {
      const part = message.parts.find(
        (p): p is PermissionPart => isPermissionPart(p) && p.id === requestId,
      );
      if (part) return part;
    }
    return undefined;
  }

  /** `timeoutMs` guards the handshake; prompt turns stay unbounded. */
  private rpc(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("no process"));
    const id = this.nextRpcId++;
    try {
      this.process.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs == null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  `Cursor Agent CLI did not answer ${method} within ${Math.round(
                    timeoutMs / 1000,
                  )}s`,
                ),
              );
            }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  private respond(id: number, result: unknown): void {
    this.process?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}

/**
 * Pick the model selector out of an ACP `configOptions` array. The spec keys it
 * by `category`; fall back to a literal `model` id for agents that omit it.
 */
export function findModelConfigOption(
  configOptions: unknown,
): AcpSessionConfigOption | null {
  if (!Array.isArray(configOptions)) return null;
  const candidates = configOptions.filter(
    (o): o is AcpSessionConfigOption =>
      o != null && typeof o === "object" && typeof (o as { id?: unknown }).id === "string",
  );
  return (
    candidates.find((o) => o.category === "model") ??
    candidates.find((o) => o.id === "model") ??
    null
  );
}

/** JSON-RPC error payloads are plain objects; keep them readable as Errors. */
function rpcError(raw: unknown): Error {
  const err = new Error(rpcMessage(raw));
  err.name = "AcpRpcError";
  return err;
}

function rpcMessage(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (raw && typeof raw === "object") {
    const obj = raw as { message?: unknown; data?: { message?: unknown } };
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (typeof obj.data?.message === "string" && obj.data.message) {
      return obj.data.message;
    }
  }
  return String(raw);
}

function isAuthRequired(err: unknown): boolean {
  return /authenticat|unauthori|not logged in/i.test(rpcMessage(err));
}
