import type { AcpExit, AcpProcess } from "./chat.js";

interface HandshakeConfig {
  sessionId: string;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  /** `session/new` model selector; omit for an agent that advertises none. */
  models?: { currentValue: string; values: string[] };
  /** Method that answers with a JSON-RPC error instead of a result. */
  fail?: { method: string; message: string };
}

/** Model selector shape used by tests that exercise live model switching. */
export const MOCK_MODEL_OPTION = {
  currentValue: "default[]",
  values: ["default[]", "composer-2.5[fast=true]", "gpt-5.5[]"],
};

/** In-memory ACP stdio stand-in for bridge and registry tests. */
export class MockAcpProcess implements AcpProcess {
  readonly written: unknown[] = [];
  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(exit: AcpExit) => void> = [];
  private readonly answered = new Set<number>();
  private handshake: HandshakeConfig | null = null;
  killed = false;

  write(line: string): void {
    if (this.killed) throw new Error("process closed");
    const message = JSON.parse(line) as { id?: number; method?: string };
    this.written.push(message);
    this.answerHandshake(message);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (exit: AcpExit) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.killed = true;
  }

  /** Simulate the agent dying on its own (crash, auth abort). */
  exit(exit: Partial<AcpExit> = {}): void {
    this.killed = true;
    const info: AcpExit = {
      code: exit.code ?? 1,
      signal: exit.signal ?? null,
      stderr: exit.stderr ?? "",
    };
    for (const handler of this.exitHandlers) handler(info);
  }

  emit(message: unknown): void {
    const line = JSON.stringify(message);
    for (const handler of this.lineHandlers) handler(line);
  }

  /**
   * Answer initialize / authenticate / session/new.
   * Default initialize omits promptCapabilities (fail-closed — text only).
   * Pass `promptCapabilities` to simulate agents that accept richer blocks.
   */
  autoHandshake(
    sessionId = "sess-test",
    opts?: {
      promptCapabilities?: HandshakeConfig["promptCapabilities"];
      models?: HandshakeConfig["models"];
    },
  ): void {
    this.answered.clear();
    this.handshake = {
      sessionId,
      ...(opts?.promptCapabilities
        ? { promptCapabilities: opts.promptCapabilities }
        : {}),
      ...(opts?.models ? { models: opts.models } : {}),
      ...(this.handshake?.fail ? { fail: this.handshake.fail } : {}),
    };
  }

  /** Model value last accepted through `session/set_config_option`. */
  currentModel(): string | null {
    return this.handshake?.models?.currentValue ?? null;
  }

  /** Every `session/set_config_option` value the bridge asked for, in order. */
  modelRequests(): string[] {
    return this.written
      .filter(
        (m): m is { method: string; params: { configId: string; value: string } } =>
          (m as { method?: string }).method === "session/set_config_option",
      )
      .filter((m) => m.params.configId === "model")
      .map((m) => m.params.value);
  }

  /** Make one handshake method answer with a JSON-RPC error. */
  failHandshake(method: string, message: string): void {
    this.handshake = {
      sessionId: this.handshake?.sessionId ?? "sess-test",
      ...(this.handshake?.promptCapabilities
        ? { promptCapabilities: this.handshake.promptCapabilities }
        : {}),
      fail: { method, message },
    };
  }

  /** Answer handshake requests written before `autoHandshake` was configured. */
  replayPendingHandshake(): void {
    for (const message of [...this.written]) {
      this.answerHandshake(message as { id?: number; method?: string });
    }
  }

  private answerHandshake(message: {
    id?: number;
    method?: string;
    params?: { configId?: string; value?: string };
  }): void {
    const config = this.handshake;
    if (!config) return;
    const { id, method } = message;
    if (id == null || method == null || this.answered.has(id)) return;

    if (config.fail?.method === method) {
      this.answered.add(id);
      queueMicrotask(() => {
        this.emit({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: config.fail!.message },
        });
      });
      return;
    }

    let result: unknown;
    if (method === "initialize") {
      result = {
        protocolVersion: 1,
        ...(config.promptCapabilities
          ? { agentCapabilities: { promptCapabilities: config.promptCapabilities } }
          : {}),
      };
    } else if (method === "authenticate") result = {};
    else if (method === "session/new") {
      result = {
        sessionId: config.sessionId,
        ...(config.models ? { configOptions: [this.modelConfigOption()] } : {}),
      };
    } else if (method === "session/set_config_option") {
      if (!config.models || message.params?.configId !== "model") return;
      const value = message.params.value;
      if (typeof value !== "string" || !config.models.values.includes(value)) {
        return;
      }
      config.models = { ...config.models, currentValue: value };
      result = { configOptions: [this.modelConfigOption()] };
    } else return;

    this.answered.add(id);
    queueMicrotask(() => {
      this.emit({ jsonrpc: "2.0", id, result });
    });
  }

  private modelConfigOption(): unknown {
    const models = this.handshake!.models!;
    return {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models.currentValue,
      options: models.values.map((value) => ({ value, name: value })),
    };
  }

  prompts(): Array<{ sessionId: string; prompt: unknown }> {
    return this.written
      .filter((m): m is { method: string; params: { sessionId: string; prompt: unknown } } => {
        const msg = m as { method?: string };
        return msg.method === "session/prompt";
      })
      .map((m) => m.params);
  }

  promptRequest(): { id: number; method: string } {
    return this.written.find(
      (m): m is { id: number; method: string } =>
        (m as { method?: string }).method === "session/prompt",
    )!;
  }
}

export async function viWaitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("viWaitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
