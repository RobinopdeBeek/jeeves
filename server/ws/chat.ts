import { nanoid } from "nanoid";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  PermissionOptionPart,
  PermissionRequestData,
} from "../../shared/chat-ws.js";
import { frameSpecAssistUserMessage } from "../../shared/spec-assist-frame.js";
import { frameTasksAssistUserMessage } from "../../shared/tasks-assist-frame.js";
import {
  decideHeadlessPermission,
  decideInteractivePermission,
} from "./acp-permissions.js";

export type { PermissionOptionPart, PermissionRequestData };
export {
  decideHeadlessPermission,
  decideInteractivePermission,
} from "./acp-permissions.js";

/** Injected stdio boundary for `agent acp` (mocked in tests). */
export interface AcpProcess {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  kill(): void;
}

export type SpawnAcp = (cwd: string) => AcpProcess | Promise<AcpProcess>;

export interface AcpLiveCallbacks {
  onStatus: (status: "ai-working" | "needs-user") => void;
  onTranscript: (messages: UIMessage[]) => void;
  /** Fired when a prompt turn reaches idle (not mid-turn detached permission). */
  onTurnComplete?: () => void;
}

export interface OpenSessionOptions {
  cwd: string;
  /** Injected when history is empty — drives the agent's opening question. */
  openingPrompt: string;
  history?: UIMessage[];
  /**
   * Live chat: auto-approve reads/routine + exchange writes; prompt only for
   * crucial actions (shell / non-exchange writes).
   */
  interactivePermissionPolicy?: InteractivePermissionPolicy;
}

/**
 * Headless permission policy for one-shot ACP runs (e.g. /to-spec).
 * Auto-approves reads/routine tools and project-store exchange writes;
 * rejects other writes and fails the run — never stalls on a permission UI.
 */
export type HeadlessPermissionPolicy = "cursor-like";

/** Live chat Cursor-like defaults — auto-approve routine; prompt for crucial. */
export type InteractivePermissionPolicy = "cursor-like";

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
  /** Live Cursor-like auto-approve for routine tools; prompt for crucial. */
  private interactivePolicy: InteractivePermissionPolicy | null = null;

  constructor(
    private readonly deps: { spawn: SpawnAcp } & Partial<AcpLiveCallbacks>,
  ) {
    this.live = {
      onStatus: deps.onStatus ?? (() => {}),
      onTranscript: deps.onTranscript ?? (() => {}),
      onTurnComplete: deps.onTurnComplete,
    };
  }

  setLiveCallbacks(callbacks: AcpLiveCallbacks): void {
    this.live = callbacks;
  }

  getMessages(): UIMessage[] {
    return this.messages;
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
   * Start an ACP session. Empty history runs the opening prompt turn.
   * Non-empty history loads messages and waits for the first user send (seed-once).
   */
  async openSession(options: OpenSessionOptions): Promise<void> {
    this.messages = options.history ? [...options.history] : [];
    this.contextSeeded = this.messages.length === 0;
    this.interactivePolicy = options.interactivePermissionPolicy ?? null;
    this.process = await this.deps.spawn(options.cwd);
    this.process.onLine((line) => this.handleLine(line));

    await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "jeeves-acp-bridge", version: "0.1.0" },
    });
    await this.rpc("authenticate", { methodId: "cursor_login" });
    const created = (await this.rpc("session/new", {
      cwd: options.cwd,
      mcpServers: [],
    })) as { sessionId: string };
    this.sessionId = created.sessionId;

    if (this.messages.length === 0) {
      this.contextSeeded = true;
      // Fire-and-forget so acquire can return and the client can attach mid-turn.
      void this.runPromptTurn(options.openingPrompt, { recordUser: false });
    }
  }

  /** Send a user message; chunks arrive via attach / onChunk buffering. */
  async sendMessage(
    text: string,
    opts?: { currentSpecMarkdown?: string; currentTasksDraftJson?: string },
  ): Promise<void> {
    if (!this.sessionId) throw new Error("session not open");
    await this.runPromptTurn(text, {
      recordUser: true,
      currentSpecMarkdown: opts?.currentSpecMarkdown,
      currentTasksDraftJson: opts?.currentTasksDraftJson,
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
    this.process?.kill();
    this.process = null;
    this.sessionId = null;
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
      currentSpecMarkdown?: string;
      currentTasksDraftJson?: string;
    },
  ): Promise<void> {
    if (!this.sessionId || !this.process) throw new Error("session not open");

    this.beginTurn();

    if (opts.recordUser) {
      this.messages.push({
        id: nanoid(10),
        role: "user",
        parts: [{ type: "text", text }],
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
      opts.currentTasksDraftJson != null
        ? frameTasksAssistUserMessage(text, opts.currentTasksDraftJson)
        : opts.currentSpecMarkdown != null
          ? frameSpecAssistUserMessage(text, opts.currentSpecMarkdown)
          : text;

    let promptText = agentText;
    if (opts.recordUser) {
      if (!this.contextSeeded) {
        promptText = this.formatPromptWithHistory(agentText);
        this.contextSeeded = true;
      }
    }

    try {
      await this.rpc("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
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
      this.live.onTurnComplete?.();
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

  private formatPromptWithHistory(latestUserText: string): string {
    const prior = this.messages.slice(0, -1);
    if (prior.length === 0) return latestUserText;
    const lines = prior.map((m) => {
      const body = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      return `${m.role === "user" ? "User" : "Assistant"}: ${body}`;
    });
    return [
      "Prior transcript (continue from here; do not repeat answered questions):",
      ...lines,
      "",
      `User: ${latestUserText}`,
    ].join("\n");
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
      if (msg.error !== undefined) waiter.reject(msg.error);
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
      const decision = decideInteractivePermission(data);
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

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("no process"));
    const id = this.nextRpcId++;
    this.process.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private respond(id: number, result: unknown): void {
    this.process?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}
