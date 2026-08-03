import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { stepChatSessionId, threadChatSessionId } from "./chat-session.js";
import { MockAcpProcess, viWaitFor } from "./mock-acp-process.js";
import {
  ChatSessionRegistry,
  MAX_LIVE_SESSIONS,
  type ChunkSubscriber,
  type DisplaceableConnection,
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

function collectingSubscriber(): ChunkSubscriber & { chunks: UIMessageChunk[] } {
  const chunks: UIMessageChunk[] = [];
  return {
    chunks,
    onChunk(chunk) {
      chunks.push(chunk);
    },
  };
}

const idA = stepChatSessionId("card-a", "grill", 0);

describe("ChatSessionRegistry — writer slot", () => {
  it("claims a session id and displaces the previous connection (last wins)", () => {
    const registry = new ChatSessionRegistry();
    const id = stepChatSessionId("card-1", "grill", 0);
    const first = fakeConn();
    const second = fakeConn();

    registry.claim(id, first);
    expect(registry.get(id)).toBe(first);

    registry.claim(id, second);
    expect(first.displacedWith).toEqual(["session continued elsewhere"]);
    expect(second.displacedWith).toEqual([]);
    expect(registry.get(id)).toBe(second);
  });

  it("release only clears the slot when the same connection still owns it", () => {
    const registry = new ChatSessionRegistry();
    const id = stepChatSessionId("card-1", "grill", 0);
    const first = fakeConn();
    const second = fakeConn();

    registry.claim(id, first);
    registry.claim(id, second);
    registry.release(id, first);
    expect(registry.get(id)).toBe(second);

    registry.release(id, second);
    expect(registry.get(id)).toBeUndefined();
  });

  it("isolates different opaque ids (card / round)", () => {
    const registry = new ChatSessionRegistry();
    const a = fakeConn();
    const b = fakeConn();
    const id0 = stepChatSessionId("c1", "grill", 0);
    const id1 = stepChatSessionId("c1", "grill", 1);
    registry.claim(id0, a);
    registry.claim(id1, b);
    expect(a.displacedWith).toEqual([]);
    expect(registry.get(id0)).toBe(a);
    expect(id0).toBe("card:c1:grill:0");
  });

  it("close displaces the writer and clears the slot", () => {
    const registry = new ChatSessionRegistry();
    const id = stepChatSessionId("card-1", "grill", 0);
    const conn = fakeConn();
    registry.claim(id, conn);

    registry.close(id, "grill handed off to spec");

    expect(conn.displacedWith).toEqual(["grill handed off to spec"]);
    expect(registry.get(id)).toBeUndefined();
  });

  it("close is a no-op when no session is claimed", () => {
    const registry = new ChatSessionRegistry();
    expect(() =>
      registry.close(
        stepChatSessionId("card-1", "grill", 0),
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

    const handle = await registry.acquire(idA, {
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
    expect(registry.hasWarm(idA)).toBe(true);
  });

  it("reacquire reuses the live bridge and delivers catch-up chunks (no second spawn)", async () => {
    let spawnCount = 0;
    const process = new MockAcpProcess();
    process.autoHandshake("sess-reuse");
    const registry = new ChatSessionRegistry();

    const handle1 = await registry.acquire(idA, {
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

    const handle2 = await registry.acquire(idA, {
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
      const id = stepChatSessionId(cardId, "grill", 0);
      const handle = await registry.acquire(id, {
        spawn: () => process,
        cwd: "C:/repo",
        openingPrompt: "hi",
        history: [{ id: "u1", role: "user", parts: [{ type: "text", text: "x" }] }],
        onStatus: () => {},
        onTranscript: () => {},
      });
      // Non-empty history: no opening turn → idle, no subscriber.
      await viWaitFor(() => registry.hasWarm(id));
      void handle;
      return process;
    }

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      await acquireIdle(`c${i}`);
      // Stagger inactiveSince so c0 is oldest.
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(registry.hasWarm(stepChatSessionId("c0", "grill", 0))).toBe(true);

    const sixth = await acquireIdle("c-new");
    expect(processes[0]!.killed).toBe(true);
    expect(registry.hasWarm(stepChatSessionId("c0", "grill", 0))).toBe(false);
    expect(registry.hasWarm(stepChatSessionId("c-new", "grill", 0))).toBe(true);
    expect(sixth.killed).toBe(false);
    expect(processes.filter((p) => !p.killed)).toHaveLength(MAX_LIVE_SESSIONS);
  });

  it("when all sessions are ai-working, admit waits for the longest-running turn then evicts", async () => {
    const registry = new ChatSessionRegistry();
    const busy: Array<{ process: MockAcpProcess; id: string }> = [];

    async function acquireBusy(cardId: string): Promise<MockAcpProcess> {
      const process = new MockAcpProcess();
      process.autoHandshake(`sess-${cardId}`);
      const id = stepChatSessionId(cardId, "grill", 0);
      const handle = await registry.acquire(id, {
        spawn: () => process,
        cwd: "C:/repo",
        openingPrompt: "work",
        history: [],
        onStatus: () => {},
        onTranscript: () => {},
      });
      handle.attach(collectingSubscriber());
      await viWaitFor(() => process.prompts().length === 1);
      busy.push({ process, id });
      return process;
    }

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      await acquireBusy(`b${i}`);
      await new Promise((r) => setTimeout(r, 5));
    }

    let admitted = false;
    const newId = stepChatSessionId("b-new", "grill", 0);
    const admitPromise = registry
      .acquire(newId, {
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
      })
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
    expect(registry.hasWarm(stepChatSessionId("b0", "grill", 0))).toBe(false);
    expect(registry.hasWarm(newId)).toBe(true);
  });

  it("permission with no subscriber flips status to needs-user", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-perm");
    const registry = new ChatSessionRegistry();
    const statuses: Array<"ai-working" | "needs-user"> = [];

    const handle = await registry.acquire(idA, {
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

    await registry.acquire(idA, {
      spawn: () => process,
      cwd: "C:/repo",
      openingPrompt: "x",
      history: [{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }],
      onStatus: () => {},
      onTranscript: () => {},
    });
    registry.claim(idA, conn);
    expect(registry.hasWarm(idA)).toBe(true);

    registry.close(idA, "grill handed off to spec");

    expect(conn.displacedWith).toEqual(["grill handed off to spec"]);
    expect(registry.get(idA)).toBeUndefined();
    expect(registry.hasWarm(idA)).toBe(false);
    expect(process.killed).toBe(true);
  });

  it("shares one warm pool across card: and thread: session ids", async () => {
    const registry = new ChatSessionRegistry();
    const processes: MockAcpProcess[] = [];

    async function acquireIdle(id: string): Promise<void> {
      const process = new MockAcpProcess();
      process.autoHandshake(`sess-${id}`);
      processes.push(process);
      await registry.acquire(id, {
        spawn: () => process,
        cwd: "C:/repo",
        openingPrompt: null,
        history: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "x" }] },
        ],
        onStatus: () => {},
        onTranscript: () => {},
      });
      await viWaitFor(() => registry.hasWarm(id));
    }

    // Fill the pool with a mix of step chats and Project Chat threads.
    for (let i = 0; i < MAX_LIVE_SESSIONS - 1; i++) {
      await acquireIdle(stepChatSessionId(`c${i}`, "grill", 0));
      await new Promise((r) => setTimeout(r, 5));
    }
    await acquireIdle(threadChatSessionId("oldest-thread"));
    await new Promise((r) => setTimeout(r, 5));

    // Oldest is c0 — admitting another thread should evict that step chat.
    await acquireIdle(threadChatSessionId("new-thread"));

    expect(processes[0]!.killed).toBe(true);
    expect(registry.hasWarm(stepChatSessionId("c0", "grill", 0))).toBe(false);
    expect(registry.hasWarm(threadChatSessionId("oldest-thread"))).toBe(true);
    expect(registry.hasWarm(threadChatSessionId("new-thread"))).toBe(true);
    expect(processes.filter((p) => !p.killed)).toHaveLength(MAX_LIVE_SESSIONS);
  });

  it("replaces the warm ACP process when the pinned model changes", async () => {
    const registry = new ChatSessionRegistry();
    const first = new MockAcpProcess();
    first.autoHandshake("sess-m1");
    const second = new MockAcpProcess();
    second.autoHandshake("sess-m2");
    const spawnModels: Array<string | null | undefined> = [];

    const spawn = (_cwd: string, options?: { model?: string | null }) => {
      spawnModels.push(options?.model);
      return spawnModels.length === 1 ? first : second;
    };

    const handle1 = await registry.acquire(idA, {
      spawn,
      cwd: "C:/repo",
      openingPrompt: null,
      history: [],
      model: "composer-2.5",
      onStatus: () => {},
      onTranscript: () => {},
    });
    expect(handle1.reused).toBe(false);
    expect(spawnModels).toEqual(["composer-2.5"]);

    const handle2 = await registry.acquire(idA, {
      spawn,
      cwd: "C:/repo",
      openingPrompt: null,
      history: [],
      model: "gpt-5.5",
      onStatus: () => {},
      onTranscript: () => {},
    });
    expect(handle2.reused).toBe(false);
    expect(first.killed).toBe(true);
    expect(spawnModels).toEqual(["composer-2.5", "gpt-5.5"]);
    expect(registry.hasWarm(idA)).toBe(true);
  });
});
