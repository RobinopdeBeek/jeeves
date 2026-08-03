import type { AcpProcess } from "./chat.js";

/** In-memory ACP stdio stand-in for bridge and registry tests. */
export class MockAcpProcess implements AcpProcess {
  readonly written: unknown[] = [];
  private readonly lineHandlers: Array<(line: string) => void> = [];
  killed = false;

  write(line: string): void {
    if (this.killed) throw new Error("process closed");
    this.written.push(JSON.parse(line));
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  kill(): void {
    this.killed = true;
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
      promptCapabilities?: {
        image?: boolean;
        audio?: boolean;
        embeddedContext?: boolean;
      };
    },
  ): void {
    const answered = new Set<number>();
    const originalWrite = this.write.bind(this);
    this.write = (line: string) => {
      originalWrite(line);
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (m.id == null || m.method == null || answered.has(m.id)) return;
      let result: unknown;
      if (m.method === "initialize") {
        result = {
          protocolVersion: 1,
          ...(opts?.promptCapabilities
            ? {
                agentCapabilities: {
                  promptCapabilities: opts.promptCapabilities,
                },
              }
            : {}),
        };
      } else if (m.method === "authenticate") result = {};
      else if (m.method === "session/new") result = { sessionId };
      else return;
      answered.add(m.id);
      queueMicrotask(() => {
        this.emit({ jsonrpc: "2.0", id: m.id, result });
      });
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
