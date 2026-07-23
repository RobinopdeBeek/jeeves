import { nanoid } from "nanoid";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  PermissionOptionPart,
  PermissionRequestData,
} from "../../shared/chat-ws.js";

export type { PermissionOptionPart, PermissionRequestData };

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
}

export interface OpenSessionOptions {
  cwd: string;
  /** Injected when history is empty — drives the agent's opening question. */
  openingPrompt: string;
  history?: UIMessage[];
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

  constructor(
    private readonly deps: { spawn: SpawnAcp } & Partial<AcpLiveCallbacks>,
  ) {
    this.live = {
      onStatus: deps.onStatus ?? (() => {}),
      onTranscript: deps.onTranscript ?? (() => {}),
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
  async sendMessage(text: string): Promise<void> {
    if (!this.sessionId) throw new Error("session not open");
    await this.runPromptTurn(text, { recordUser: true });
  }

  close(): void {
    this.subscriber = null;
    this.pendingPermissions.clear();
    this.process?.kill();
    this.process = null;
    this.sessionId = null;
  }

  private beginTurn(): void {
    this.activity = "ai-working";
    this.awaitingDetachedPermission = false;
    this.turnStartedAt = Date.now();
    this.turnChunks = [];
    this.turnDone = new Promise((resolve) => {
      this.resolveTurnDone = resolve;
    });
    this.live.onStatus("ai-working");
  }

  private endTurn(): void {
    this.activity = "idle";
    this.awaitingDetachedPermission = false;
    this.turnStartedAt = 0;
    this.turnChunks = [];
    this.inactiveSince = Date.now();
    this.resolveTurnDone?.();
    this.resolveTurnDone = null;
    this.live.onStatus("needs-user");
  }

  private async runPromptTurn(
    text: string,
    opts: { recordUser: boolean },
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

    let promptText = text;
    if (opts.recordUser) {
      if (!this.contextSeeded) {
        promptText = this.formatPromptWithHistory(text);
        this.contextSeeded = true;
      }
    }

    try {
      await this.rpc("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
      this.pushChunk({ type: "text-end", id: textId });
      this.pushChunk({ type: "finish", finishReason: "stop" });
      if (this.currentAssistant) {
        this.messages.push(this.currentAssistant);
        this.currentAssistant = null;
      }
      this.currentTextId = null;
      this.live.onTranscript(this.messages);
      this.endTurn();
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
        const delta = update.content.text;
        if (this.currentAssistant) {
          const part = this.currentAssistant.parts[0];
          if (part && part.type === "text") {
            part.text += delta;
          }
        }
        this.pushChunk({
          type: "text-delta",
          id: this.currentTextId,
          delta,
        });
      }
      return;
    }

    if (msg.method === "session/request_permission" && msg.id != null) {
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

    this.pendingPermissions.set(requestId, rpcId);
    this.pushChunk(permissionChunk(requestId, data));
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
