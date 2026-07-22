import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import type { AcpProcess } from "./chat.js";
import {
  ChatSessionRegistry,
  MAX_LIVE_SESSIONS,
  sessionKeyString,
  type ChunkSubscriber,
  type DisplaceableConnection,
  type SessionKey,
} from "./session-registry.js";

function fakeConn(): DisplaceableConnection & { displacedWith: string[] } {
  const displacedWith: string[] = [];
  return {
    displacedWith,
    displace(reason: string) {
      displacedWith.push(reason);
    },
  };
}

/** In-memory ACP stdio stand-in for warm-registry tests. */
class MockAcpProcess implements AcpProcess {
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

  autoHandshake(sessionId = "sess-test"): void {
    const answered = new Set<number>();
    const originalWrite = this.write.bind(this);
    this.write = (line: string) => {
      originalWrite(line);
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (m.id == null || m.method == null || answered.has(m.id)) return;
      let result: unknown;
      if (m.method === "initialize") result = { protocolVersion: 1 };
      else if (m.method === "authenticate") result = {};
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

async function viWaitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("viWaitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function collectingSubscriber(): ChunkSubscriber & { chunks: UIMessageChunk[] } {
  const chunks: UIMessageChunk[] = [];
  return {
    chunks,
    onChunk(chunk) {
      chunks.push(chunk);
    },
  };
}

const keyA: SessionKey = { cardId: "card-a", stepKey: "grill", round: 0 };

describe("ChatSessionRegistry — writer slot", () => {
  it("claims a session key and displaces the previous connection (last wins)", () => {
    const registry = new ChatSessionRegistry();
    const key = { cardId: "card-1", stepKey: "grill" as const, round: 0 };
    const first = fakeConn();
    const second = fakeConn();

    registry.claim(key, first);
    expect(registry.get(key)).toBe(first);

    registry.claim(key, second);
    expect(first.displacedWith).toEqual(["session continued elsewhere"]);
    expect(second.displacedWith).toEqual([]);
    expect(registry.get(key)).toBe(second);
  });

  it("release only clears the slot when the same connection still owns it", () => {
    const registry = new ChatSessionRegistry();
    const key = { cardId: "card-1", stepKey: "grill" as const, round: 0 };
    const first = fakeConn();
    const second = fakeConn();

    registry.claim(key, first);
    registry.claim(key, second);
    registry.release(key, first);
    expect(registry.get(key)).toBe(second);

    registry.release(key, second);
    expect(registry.get(key)).toBeUndefined();
  });

  it("isolates different cards / rounds", () => {
    const registry = new ChatSessionRegistry();
    const a = fakeConn();
    const b = fakeConn();
    registry.claim({ cardId: "c1", stepKey: "grill", round: 0 }, a);
    registry.claim({ cardId: "c1", stepKey: "grill", round: 1 }, b);
    expect(a.displacedWith).toEqual([]);
    expect(registry.get({ cardId: "c1", stepKey: "grill", round: 0 })).toBe(a);
    expect(sessionKeyString({ cardId: "c1", stepKey: "grill", round: 0 })).toBe(
      "c1:grill:0",
    );
  });

  it("close displaces the writer and clears the slot", () => {
    const registry = new ChatSessionRegistry();
    const key = { cardId: "card-1", stepKey: "grill" as const, round: 0 };
    const conn = fakeConn();
    registry.claim(key, conn);

    registry.close(key, "grill handed off to spec");

    expect(conn.displacedWith).toEqual(["grill handed off to spec"]);
    expect(registry.get(key)).toBeUndefined();
  });

  it("close is a no-op when no session is claimed", () => {
    const registry = new ChatSessionRegistry();
    expect(() =>
      registry.close(
        { cardId: "card-1", stepKey: "grill", round: 0 },
        "grill handed off to spec",
      ),
    ).not.toThrow();
  });
});

describe("ChatSessionRegistry — warm bridges", () => {
  it("detach leaves the ACP process alive so an in-flight turn can finish", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-warm");
    const registry = new ChatSessionRegistry();
    const statuses: Array<"ai-working" | "needs-user"> = [];
    const transcripts: unknown[] = [];

    const handle = await registry.acquire(keyA, {
      spawn: () => process,
      cwd: "C:/repo",
      openingPrompt: "Grill me",
      history: [],
      onStatus: (s) => statuses.push(s),
      onTranscript: (m) => transcripts.push(m),
    });
    expect(handle.reused).toBe(false);

    const sub = collectingSubscriber();
    handle.attach(sub);

    await viWaitFor(() => process.prompts().length === 1);
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-warm",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        },
      },
    });
    await viWaitFor(() => sub.chunks.some((c) => c.type === "text-delta"));

    handle.detach(sub);
    expect(process.killed).toBe(false);

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-warm",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world" },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await viWaitFor(() => statuses.includes("needs-user"));
    expect(process.killed).toBe(false);
    expect(transcripts).toHaveLength(1);
    expect(registry.hasWarm(keyA)).toBe(true);
  });

  it("reacquire reuses the live bridge and delivers catch-up chunks (no second spawn)", async () => {
    let spawnCount = 0;
    const process = new MockAcpProcess();
    process.autoHandshake("sess-reuse");
    const registry = new ChatSessionRegistry();

    const handle1 = await registry.acquire(keyA, {
      spawn: () => {
        spawnCount += 1;
        return process;
      },
      cwd: "C:/repo",
      openingPrompt: "Grill me",
      history: [],
      onStatus: () => {},
      onTranscript: () => {},
    });
    const sub1 = collectingSubscriber();
    handle1.attach(sub1);

    await viWaitFor(() => process.prompts().length === 1);
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-reuse",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "mid-" },
        },
      },
    });
    await viWaitFor(() => sub1.chunks.some((c) => c.type === "text-delta"));
    handle1.detach(sub1);

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-reuse",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "stream" },
        },
      },
    });

    const handle2 = await registry.acquire(keyA, {
      spawn: () => {
        spawnCount += 1;
        return process;
      },
      cwd: "C:/repo",
      openingPrompt: "Grill me",
      history: [],
      onStatus: () => {},
      onTranscript: () => {},
    });
    expect(handle2.reused).toBe(true);
    expect(spawnCount).toBe(1);

    const sub2 = collectingSubscriber();
    handle2.attach(sub2);
    expect(
      sub2.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join(""),
    ).toBe("mid-stream");

    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });
    await viWaitFor(() => sub2.chunks.some((c) => c.type === "finish"));
  });

  it(`evicts the longest-inactive idle session when opening the ${MAX_LIVE_SESSIONS + 1}th`, async () => {
    const registry = new ChatSessionRegistry();
    const processes: MockAcpProcess[] = [];

    async function acquireIdle(cardId: string): Promise<MockAcpProcess> {
      const process = new MockAcpProcess();
      process.autoHandshake(`sess-${cardId}`);
      processes.push(process);
      const handle = await registry.acquire(
        { cardId, stepKey: "grill", round: 0 },
        {
          spawn: () => process,
          cwd: "C:/repo",
          openingPrompt: "hi",
          history: [{ id: "u1", role: "user", parts: [{ type: "text", text: "x" }] }],
          onStatus: () => {},
          onTranscript: () => {},
        },
      );
      // Empty opening stream finishes immediately → idle, no subscriber.
      await viWaitFor(() => registry.hasWarm({ cardId, stepKey: "grill", round: 0 }));
      void handle;
      return process;
    }

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      await acquireIdle(`c${i}`);
      // Stagger inactiveSince so c0 is oldest.
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(registry.hasWarm({ cardId: "c0", stepKey: "grill", round: 0 })).toBe(true);

    const sixth = await acquireIdle("c-new");
    expect(processes[0]!.killed).toBe(true);
    expect(registry.hasWarm({ cardId: "c0", stepKey: "grill", round: 0 })).toBe(false);
    expect(registry.hasWarm({ cardId: "c-new", stepKey: "grill", round: 0 })).toBe(true);
    expect(sixth.killed).toBe(false);
    expect(processes.filter((p) => !p.killed)).toHaveLength(MAX_LIVE_SESSIONS);
  });

  it("when all sessions are ai-working, admit waits for the longest-running turn then evicts", async () => {
    const registry = new ChatSessionRegistry();
    const busy: Array<{ process: MockAcpProcess; cardId: string }> = [];

    async function acquireBusy(cardId: string): Promise<MockAcpProcess> {
      const process = new MockAcpProcess();
      process.autoHandshake(`sess-${cardId}`);
      const handle = await registry.acquire(
        { cardId, stepKey: "grill", round: 0 },
        {
          spawn: () => process,
          cwd: "C:/repo",
          openingPrompt: "work",
          history: [],
          onStatus: () => {},
          onTranscript: () => {},
        },
      );
      handle.attach(collectingSubscriber());
      await viWaitFor(() => process.prompts().length === 1);
      busy.push({ process, cardId });
      return process;
    }

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      await acquireBusy(`b${i}`);
      await new Promise((r) => setTimeout(r, 5));
    }

    let admitted = false;
    const admitPromise = registry
      .acquire(
        { cardId: "b-new", stepKey: "grill", round: 0 },
        {
          spawn: () => {
            const p = new MockAcpProcess();
            p.autoHandshake("sess-new");
            return p;
          },
          cwd: "C:/repo",
          openingPrompt: "new",
          history: [{ id: "u", role: "user", parts: [{ type: "text", text: "x" }] }],
          onStatus: () => {},
          onTranscript: () => {},
        },
      )
      .then(() => {
        admitted = true;
      });

    await new Promise((r) => setTimeout(r, 30));
    expect(admitted).toBe(false);

    // Finish the longest-running (b0) turn — transcript/status fire before stream ends.
    const oldest = busy[0]!;
    oldest.process.emit({
      jsonrpc: "2.0",
      id: oldest.process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await admitPromise;
    expect(admitted).toBe(true);
    expect(oldest.process.killed).toBe(true);
    expect(registry.hasWarm({ cardId: "b0", stepKey: "grill", round: 0 })).toBe(false);
    expect(registry.hasWarm({ cardId: "b-new", stepKey: "grill", round: 0 })).toBe(true);
  });

  it("permission with no subscriber flips status to needs-user", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-perm");
    const registry = new ChatSessionRegistry();
    const statuses: Array<"ai-working" | "needs-user"> = [];

    const handle = await registry.acquire(keyA, {
      spawn: () => process,
      cwd: "C:/repo",
      openingPrompt: "Grill",
      history: [],
      onStatus: (s) => statuses.push(s),
      onTranscript: () => {},
    });
    // Never attach — detached for the whole opening turn.
    await viWaitFor(() => process.prompts().length === 1);

    process.emit({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "sess-perm",
        toolCall: { toolCallId: "tc-1", title: "Read file" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() => statuses.includes("needs-user"));
    expect(statuses[0]).toBe("ai-working");
    expect(handle.getPendingPermissionIds()).toContain("99");
  });

  it("close kills the warm bridge and drops the registry entry", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-close");
    const registry = new ChatSessionRegistry();
    const conn = fakeConn();

    await registry.acquire(keyA, {
      spawn: () => process,
      cwd: "C:/repo",
      openingPrompt: "x",
      history: [{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }],
      onStatus: () => {},
      onTranscript: () => {},
    });
    registry.claim(keyA, conn);
    expect(registry.hasWarm(keyA)).toBe(true);

    registry.close(keyA, "grill handed off to spec");

    expect(conn.displacedWith).toEqual(["grill handed off to spec"]);
    expect(registry.get(keyA)).toBeUndefined();
    expect(registry.hasWarm(keyA)).toBe(false);
    expect(process.killed).toBe(true);
  });
});
