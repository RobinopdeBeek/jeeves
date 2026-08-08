import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import {
  type ChatSession,
  stepChatSessionId,
  threadChatSessionId,
} from "./chat-session.js";
import {
  MOCK_MODEL_OPTION,
  MockAcpProcess,
  viWaitFor,
} from "./mock-acp-process.js";
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

function testSession(
  id: string,
  overrides: Partial<ChatSession> & {
    history?: UIMessage[];
    onStatus?: ChatSession["notifyStatus"];
    onTranscript?: ChatSession["saveTranscript"];
  } = {},
): ChatSession {
  const history = overrides.history ?? [];
  return {
    id,
    cwd: overrides.cwd ?? "/tmp/repo",
    openingPrompt: overrides.openingPrompt ?? null,
    model: overrides.model,
    loadTranscript: () => history,
    saveTranscript: overrides.onTranscript ?? (() => {}),
    assertMutable: overrides.assertMutable ?? (() => {}),
    notifyStatus: overrides.onStatus ?? (() => {}),
    interactivePermissionPolicy: overrides.interactivePermissionPolicy,
    frameUserMessage: overrides.frameUserMessage,
    onTurnComplete: overrides.onTurnComplete,
    onModelChanged: overrides.onModelChanged,
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

    const handle = await registry.acquire(
      testSession(idA, {
        cwd: "C:/repo",
        openingPrompt: "Grill me",
        history: [],
        onStatus: (s) => statuses.push(s),
        onTranscript: (m) => transcripts.push(m),
      }),
      { spawn: () => process },
    );
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

  it("exposes mid-turn warm messages after detach so ready can reseed the user prompt", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-reattach");
    const registry = new ChatSessionRegistry();
    const threadId = threadChatSessionId("thread-1");

    const handle = await registry.acquire(
      testSession(threadId, {
        cwd: "C:/repo",
        openingPrompt: null,
        history: [],
      }),
      { spawn: () => process },
    );

    const sub = collectingSubscriber();
    handle.attach(sub);
    void handle.sendMessage("Where did my prompt go?").catch(() => undefined);
    await viWaitFor(() => process.prompts().length === 1);
    expect(registry.isAiWorking(threadId)).toBe(true);

    handle.detach(sub);

    const warm = registry.peekWarmMessages(threadId);
    expect(warm?.map((m) => m.role)).toEqual(["user"]);
    expect(warm?.[0]?.parts).toEqual([
      { type: "text", text: "Where did my prompt go?" },
    ]);
    expect(registry.isAiWorking(threadId)).toBe(true);

    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });
    await handle.bridge.whenIdle();
  });

  it("a second acquire during the handshake waits instead of reusing a half-open bridge", async () => {
    let spawnCount = 0;
    const process = new MockAcpProcess();
    const registry = new ChatSessionRegistry();
    // Handshake stays unanswered until we release it below.
    const spawn = () => {
      spawnCount += 1;
      return process;
    };
    const session = () =>
      testSession(idA, { cwd: "C:/repo", openingPrompt: null, history: [] });

    const first = registry.acquire(session(), { spawn });
    await viWaitFor(() => spawnCount === 1);
    const second = registry.acquire(session(), { spawn });

    // Nothing may be handed out while the ACP session id is still null —
    // a "reused" handle here would let the client send into a dead session.
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondSettled).toBe(false);

    process.autoHandshake("sess-race");
    process.replayPendingHandshake();

    const [handleA, handleB] = await Promise.all([first, second]);
    expect(spawnCount).toBe(1);
    expect(handleB.bridge).toBe(handleA.bridge);

    // Provable liveness: the shared bridge prompts the real ACP session.
    void handleB.sendMessage("hi").catch(() => undefined);
    await viWaitFor(() => process.prompts().length === 1);
    expect(process.prompts()[0]?.sessionId).toBe("sess-race");
  });

  it("a failed handshake kills the process and leaves no warm bridge behind", async () => {
    const process = new MockAcpProcess();
    process.failHandshake("session/new", "Authentication required");
    const registry = new ChatSessionRegistry();

    await expect(
      registry.acquire(
        testSession(idA, { cwd: "C:/repo", openingPrompt: null, history: [] }),
        { spawn: () => process },
      ),
    ).rejects.toThrow(/Authentication required/);

    expect(registry.hasWarm(idA)).toBe(false);
    expect(process.killed).toBe(true);
  });

  it("reacquire reuses the live bridge and delivers catch-up chunks (no second spawn)", async () => {
    let spawnCount = 0;
    const process = new MockAcpProcess();
    process.autoHandshake("sess-reuse");
    const registry = new ChatSessionRegistry();

    const spawn = () => {
      spawnCount += 1;
      return process;
    };

    const handle1 = await registry.acquire(
      testSession(idA, {
        cwd: "C:/repo",
        openingPrompt: "Grill me",
        history: [],
        onStatus: () => {},
        onTranscript: () => {},
      }),
      { spawn },
    );
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

    const handle2 = await registry.acquire(
      testSession(idA, {
        cwd: "C:/repo",
        openingPrompt: "Grill me",
        history: [],
        onStatus: () => {},
        onTranscript: () => {},
      }),
      { spawn },
    );
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
      const handle = await registry.acquire(
        testSession(id, {
          cwd: "C:/repo",
          openingPrompt: "hi",
          history: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "x" }] },
          ],
          onStatus: () => {},
          onTranscript: () => {},
        }),
        { spawn: () => process },
      );
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
      const handle = await registry.acquire(
        testSession(id, {
          cwd: "C:/repo",
          openingPrompt: "work",
          history: [],
          onStatus: () => {},
          onTranscript: () => {},
        }),
        { spawn: () => process },
      );
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
      .acquire(
        testSession(newId, {
          cwd: "C:/repo",
          openingPrompt: "new",
          history: [
            { id: "u", role: "user", parts: [{ type: "text", text: "x" }] },
          ],
          onStatus: () => {},
          onTranscript: () => {},
        }),
        {
          spawn: () => {
            const p = new MockAcpProcess();
            p.autoHandshake("sess-new");
            return p;
          },
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
    expect(registry.hasWarm(stepChatSessionId("b0", "grill", 0))).toBe(false);
    expect(registry.hasWarm(newId)).toBe(true);
  });

  it("permission with no subscriber flips status to needs-user", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-perm");
    const registry = new ChatSessionRegistry();
    const statuses: Array<"ai-working" | "needs-user"> = [];

    const handle = await registry.acquire(
      testSession(idA, {
        cwd: "C:/repo",
        openingPrompt: "Grill",
        history: [],
        onStatus: (s) => statuses.push(s),
        onTranscript: () => {},
      }),
      { spawn: () => process },
    );
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

    await registry.acquire(
      testSession(idA, {
        cwd: "C:/repo",
        openingPrompt: "x",
        history: [
          { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
        onStatus: () => {},
        onTranscript: () => {},
      }),
      { spawn: () => process },
    );
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
      await registry.acquire(
        testSession(id, {
          cwd: "C:/repo",
          openingPrompt: null,
          history: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "x" }] },
          ],
          onStatus: () => {},
          onTranscript: () => {},
        }),
        { spawn: () => process },
      );
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

  it("pins the session's model on the live process instead of respawning", async () => {
    const registry = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-m1", { models: MOCK_MODEL_OPTION });
    let spawns = 0;
    const spawn = () => {
      spawns++;
      return process;
    };

    await registry.acquire(
      testSession(idA, { cwd: "C:/repo", model: "composer-2.5[fast=true]" }),
      { spawn },
    );
    expect(process.modelRequests()).toEqual(["composer-2.5[fast=true]"]);

    await registry.setModel(idA, "gpt-5.5[]");

    expect(spawns).toBe(1);
    expect(process.killed).toBe(false);
    expect(process.currentModel()).toBe("gpt-5.5[]");
    expect(registry.hasWarm(idA)).toBe(true);
  });

  it("migrates a legacy bare model id onto the agent's variant string", async () => {
    const registry = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-m2", { models: MOCK_MODEL_OPTION });

    await registry.acquire(testSession(idA, { model: "composer-2.5" }), {
      spawn: () => process,
    });

    expect(process.currentModel()).toBe("composer-2.5[fast=true]");
  });

  it("leaves the agent on its own default when the thread is on Auto", async () => {
    const registry = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-m3", { models: MOCK_MODEL_OPTION });

    await registry.acquire(testSession(idA, { model: null }), {
      spawn: () => process,
    });

    expect(process.modelRequests()).toEqual([]);
  });

  it("survives an agent that advertises no model selector", async () => {
    const registry = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-m4");

    const handle = await registry.acquire(
      testSession(idA, { model: "composer-2.5" }),
      { spawn: () => process },
    );

    expect(handle.reused).toBe(false);
    expect(process.modelRequests()).toEqual([]);
    await expect(registry.setModel(idA, "gpt-5.5[]")).resolves.toBeUndefined();
  });

  it("reports an agent-initiated model change to the session", async () => {
    const registry = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-m5", { models: MOCK_MODEL_OPTION });
    const changes: string[] = [];

    await registry.acquire(
      testSession(idA, { onModelChanged: (value) => changes.push(value) }),
      { spawn: () => process },
    );

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-m5",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              category: "model",
              type: "select",
              currentValue: "gpt-5.5[]",
              options: MOCK_MODEL_OPTION.values.map((value) => ({
                value,
                name: value,
              })),
            },
          ],
        },
      },
    });

    await viWaitFor(() => changes.length > 0);
    expect(changes).toEqual(["gpt-5.5[]"]);
  });
});

describe("ChatSessionRegistry — spare pool", () => {
  const cwd = "C:/repo";

  it("hands a pre-warmed process to the first acquire, with no new spawn", async () => {
    const registry = new ChatSessionRegistry();
    const spare = new MockAcpProcess();
    spare.autoHandshake("sess-spare");
    const spawned: MockAcpProcess[] = [];
    const spawn = () => {
      const next = spawned.length === 0 ? spare : freshProcess(spawned.length);
      spawned.push(next);
      return next;
    };

    registry.prewarm(cwd, spawn);
    await viWaitFor(() => registry.hasSpare(cwd));

    const handle = await registry.acquire(testSession(idA, { cwd }), { spawn });

    expect(handle.bridge.getMessages()).toEqual([]);
    expect(registry.hasWarm(idA)).toBe(true);
    expect(spare.killed).toBe(false);
    // One process for the adopted session, one to top the spare back up.
    expect(spawned).toHaveLength(2);
    expect(registry.hasSpare(cwd)).toBe(true);
    registry.closeSpares();
  });

  it("is idempotent per cwd, so a StrictMode double-mount warms one process", async () => {
    const registry = new ChatSessionRegistry();
    let spawns = 0;
    const spawn = () => {
      spawns++;
      return freshProcess(spawns);
    };

    registry.prewarm(cwd, spawn);
    registry.prewarm(cwd, spawn);
    await viWaitFor(() => registry.hasSpare(cwd));

    expect(spawns).toBe(1);
    registry.closeSpares();
  });

  it("adopts the session's history and opening prompt onto the spare", async () => {
    const registry = new ChatSessionRegistry();
    const spare = new MockAcpProcess();
    spare.autoHandshake("sess-adopt");
    const history: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "earlier" }] },
    ];

    registry.prewarm(cwd, () => spare);
    await viWaitFor(() => registry.hasSpare(cwd));

    const handle = await registry.acquire(testSession(idA, { cwd, history }), {
      spawn: () => freshProcess(99),
    });

    expect(handle.bridge.getMessages()).toEqual(history);
    registry.closeSpares();
  });

  it("never evicts a live session to make room for a spare", async () => {
    const registry = new ChatSessionRegistry();
    const spawn = () => freshProcess(Math.random());

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      await registry.acquire(
        testSession(stepChatSessionId(`c${i}`, "grill", 0), { cwd }),
        { spawn },
      );
    }

    registry.prewarm(cwd, spawn);

    expect(registry.hasSpare(cwd)).toBe(false);
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      expect(registry.hasWarm(stepChatSessionId(`c${i}`, "grill", 0))).toBe(true);
    }
  });

  it("evicts a spare for capacity only when it is the stalest process", async () => {
    const registry = new ChatSessionRegistry();
    const spawn = () => freshProcess(Math.random());

    // Spare first, so it is the least-recently-used candidate.
    registry.prewarm(cwd, spawn);
    await viWaitFor(() => registry.hasSpare(cwd));
    await new Promise((r) => setTimeout(r, 5));

    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      await registry.acquire(
        // A different cwd, so these cold-spawn instead of claiming the spare.
        testSession(stepChatSessionId(`c${i}`, "grill", 0), { cwd: "C:/other" }),
        { spawn },
      );
      await new Promise((r) => setTimeout(r, 5));
    }

    // The spare was the stalest, so it went first and every session survived.
    expect(registry.hasSpare(cwd)).toBe(false);
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      expect(registry.hasWarm(stepChatSessionId(`c${i}`, "grill", 0))).toBe(true);
    }
  });

  it("kills a spare whose handshake fails and does not hand it out", async () => {
    const registry = new ChatSessionRegistry();
    const failing = new MockAcpProcess();
    failing.failHandshake("session/new", "auth required");
    const replacement = new MockAcpProcess();
    replacement.autoHandshake("sess-ok");
    const spawns: MockAcpProcess[] = [];
    const spawn = () => {
      const next = spawns.length === 0 ? failing : replacement;
      spawns.push(next);
      return next;
    };

    registry.prewarm(cwd, spawn);
    await viWaitFor(() => failing.killed);
    expect(registry.hasSpare(cwd)).toBe(false);

    // The next acquire cold-spawns rather than inheriting the dead spare.
    const handle = await registry.acquire(testSession(idA, { cwd }), { spawn });
    expect(handle.reused).toBe(false);
    expect(registry.hasWarm(idA)).toBe(true);
    registry.closeSpares();
  });

  it("cold-spawns instead of adopting a spare that died while it waited", async () => {
    const registry = new ChatSessionRegistry();
    const spare = new MockAcpProcess();
    spare.autoHandshake("sess-dead");
    const replacement = new MockAcpProcess();
    replacement.autoHandshake("sess-live");
    const spawns: MockAcpProcess[] = [];
    const spawn = () => {
      const next = spawns.length === 0 ? spare : replacement;
      spawns.push(next);
      return next;
    };

    registry.prewarm(cwd, spawn);
    await viWaitFor(() => registry.hasSpare(cwd));

    // Nobody is watching a spare, so its death has to be noticed at claim time.
    spare.exit({ code: 1, stderr: "agent crashed" });

    const handle = await registry.acquire(testSession(idA, { cwd }), { spawn });

    expect(handle.bridge.hasOpenSession()).toBe(true);
    expect(spawns).toEqual([spare, replacement]);
    expect(registry.hasWarm(idA)).toBe(true);
    registry.closeSpares();
  });

  it("kills every spare on shutdown so no orphan agent survives", async () => {
    const registry = new ChatSessionRegistry();
    const spare = new MockAcpProcess();
    spare.autoHandshake("sess-shutdown");

    registry.prewarm(cwd, () => spare);
    await viWaitFor(() => registry.hasSpare(cwd));

    registry.closeSpares();

    expect(spare.killed).toBe(true);
    expect(registry.hasSpare(cwd)).toBe(false);
  });
});

let spareSeq = 0;
function freshProcess(_tag: number | string): MockAcpProcess {
  const process = new MockAcpProcess();
  process.autoHandshake(`sess-auto-${spareSeq++}`);
  return process;
}
