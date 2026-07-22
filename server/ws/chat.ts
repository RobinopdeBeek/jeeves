import { nanoid } from "nanoid";
import type { UIMessage, UIMessageChunk } from "ai";

/** Injected stdio boundary for `agent acp` (mocked in tests). */
export interface AcpProcess {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  kill(): void;
}

export type SpawnAcp = (cwd: string) => AcpProcess;

export interface AcpBridgeCallbacks {
  onStatus?: (status: "ai-working" | "needs-user") => void;
  onTranscript?: (messages: UIMessage[]) => void;
}

export interface OpenSessionOptions {
  cwd: string;
  /** Injected when history is empty — drives the agent's opening question. */
  openingPrompt: string;
  history?: UIMessage[];
}

export class AcpBridge {
  private process: AcpProcess | null = null;
  private sessionId: string | null = null;
  private nextRpcId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void }
  >();
  private messages: UIMessage[] = [];
  private currentTextId: string | null = null;
  private currentAssistant: UIMessage | null = null;
  private chunkPush: ((chunk: UIMessageChunk | null) => void) | null = null;

  constructor(
    private readonly deps: { spawn: SpawnAcp } & AcpBridgeCallbacks,
  ) {}

  getMessages(): UIMessage[] {
    return this.messages;
  }

  /**
   * Start an ACP session. With empty history, sends `openingPrompt` and yields
   * the projected UIMessage stream for that opening turn.
   */
  async openSession(options: OpenSessionOptions): Promise<AsyncIterable<UIMessageChunk>> {
    this.messages = options.history ? [...options.history] : [];
    this.process = this.deps.spawn(options.cwd);
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
      return this.runPromptTurn(options.openingPrompt, { recordUser: false });
    }

    // Resume path: history already loaded; no automatic opener.
    return emptyChunkStream();
  }

  /** Send a user message and stream the assistant reply as UIMessage chunks. */
  async sendMessage(text: string): Promise<AsyncIterable<UIMessageChunk>> {
    if (!this.sessionId) throw new Error("session not open");
    return this.runPromptTurn(text, { recordUser: true });
  }

  close(): void {
    this.process?.kill();
    this.process = null;
    this.sessionId = null;
  }

  private async runPromptTurn(
    text: string,
    opts: { recordUser: boolean },
  ): Promise<AsyncIterable<UIMessageChunk>> {
    if (!this.sessionId || !this.process) throw new Error("session not open");

    this.deps.onStatus?.("ai-working");

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

    const stream = this.createChunkIterable();
    this.pushChunk({ type: "start", messageId });
    this.pushChunk({ type: "text-start", id: textId });

    const promptText = opts.recordUser ? this.formatPromptWithHistory(text) : text;

    const promptPromise = this.rpc("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });

    void promptPromise.then(
      () => {
        this.pushChunk({ type: "text-end", id: textId });
        this.pushChunk({ type: "finish", finishReason: "stop" });
        if (this.currentAssistant) {
          this.messages.push(this.currentAssistant);
          this.currentAssistant = null;
        }
        this.currentTextId = null;
        this.deps.onTranscript?.(this.messages);
        this.deps.onStatus?.("needs-user");
        this.pushChunk(null);
      },
      (err) => {
        this.pushChunk({
          type: "error",
          errorText: err instanceof Error ? err.message : String(err),
        });
        this.deps.onStatus?.("needs-user");
        this.pushChunk(null);
      },
    );

    return stream;
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
      "Prior grilling transcript (continue from here; do not repeat answered questions):",
      ...lines,
      "",
      `User: ${latestUserText}`,
    ].join("\n");
  }

  private createChunkIterable(): AsyncIterable<UIMessageChunk> {
    const queue: Array<UIMessageChunk | null> = [];
    let wake: (() => void) | null = null;

    this.chunkPush = (chunk) => {
      queue.push(chunk);
      wake?.();
      wake = null;
    };

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const value = queue.shift()!;
          if (value === null) return { done: true as const, value: undefined };
          return { done: false as const, value };
        },
      }),
    };
  }

  private pushChunk(chunk: UIMessageChunk | null): void {
    this.chunkPush?.(chunk);
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
      // Slice 5B: auto-allow so tools work in demos. Permission UI parts → later slice.
      this.respond(msg.id, {
        outcome: { outcome: "selected", optionId: "allow-once" },
      });
    }
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

async function* emptyChunkStream(): AsyncIterable<UIMessageChunk> {
  // no chunks
}
