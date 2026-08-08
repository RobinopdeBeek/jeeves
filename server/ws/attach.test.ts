import type { WSContext } from "hono/ws";
import { describe, expect, it } from "vitest";
import type { WsClientMessage } from "../../shared/chat-ws.js";
import { ChatConnection, type ChatWsDeps } from "./attach.js";

const stepTarget = {
  kind: "step" as const,
  ref: { cardId: "c1", stepKey: "grill" as const, round: 0 },
};

type ConnInternals = {
  handle: {
    cancelTurn: () => void;
    sendMessage: (
      text: string,
      opts?: { liveDraftBody?: string; attachments?: unknown },
    ) => Promise<void>;
    respondToPermission: () => void;
    attach: () => void;
    detach: () => void;
    getPendingPermissionIds: () => string[];
    getPromptCapabilities: () => {
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
    };
  } | null;
  sending: boolean;
  pendingUserMessage: WsClientMessage | null;
  flushPendingUserMessage: () => Promise<void>;
};

function harness() {
  const sent: string[] = [];
  const ws = {
    send: (data: string) => sent.push(data),
    close: () => {},
  } as unknown as WSContext;
  // Minimal sessions stub so close()/displace() can release the writer slot.
  const deps = {
    sessions: {
      claim: () => {},
      release: () => {},
      isAiWorking: () => false,
      peekWarmMessages: () => null,
    },
  } as unknown as ChatWsDeps;
  return { sent, conn: new ChatConnection(ws, stepTarget, deps) };
}

function injectHandle(
  conn: ChatConnection,
  overrides: Partial<NonNullable<ConnInternals["handle"]>> = {},
): {
  sends: Array<{
    text: string;
    opts?: { liveDraftBody?: string; attachments?: unknown };
  }>;
} {
  const sends: Array<{
    text: string;
    opts?: { liveDraftBody?: string; attachments?: unknown };
  }> = [];
  (conn as unknown as ConnInternals).handle = {
    cancelTurn: () => {},
    sendMessage: async (text, opts) => {
      sends.push({ text, opts });
    },
    respondToPermission: () => {},
    attach: () => {},
    detach: () => {},
    getPendingPermissionIds: () => [],
    getPromptCapabilities: () => ({
      image: false,
      audio: false,
      embeddedContext: false,
    }),
    ...overrides,
  };
  return { sends };
}

describe("ChatConnection liveness", () => {
  it("answers ping with pong while the ACP session is still starting", async () => {
    const { sent, conn } = harness();

    await conn.onClientMessage(JSON.stringify({ type: "ping", id: "p1" }));

    expect(sent.map((s) => JSON.parse(s) as unknown)).toEqual([
      { type: "pong", id: "p1" },
    ]);
  });

  it("buffers a user-message until the session handle is attached, then delivers once", async () => {
    const { sent, conn } = harness();
    const internals = conn as unknown as ConnInternals;

    await conn.onClientMessage(
      JSON.stringify({ type: "user-message", text: "hi" }),
    );
    expect(sent).toEqual([]);
    expect(internals.pendingUserMessage).toEqual({
      type: "user-message",
      text: "hi",
    });

    const { sends } = injectHandle(conn);
    await internals.flushPendingUserMessage();

    expect(sends).toEqual([{ text: "hi", opts: {} }]);
    expect(internals.pendingUserMessage).toBeNull();

    // Second flush is a no-op — delivered exactly once.
    await internals.flushPendingUserMessage();
    expect(sends).toHaveLength(1);
  });

  it("drops a buffered user-message without error when the connection closes before open", async () => {
    const { sent, conn } = harness();
    const internals = conn as unknown as ConnInternals;

    await conn.onClientMessage(
      JSON.stringify({ type: "user-message", text: "hi" }),
    );
    expect(internals.pendingUserMessage).not.toBeNull();

    conn.close();
    expect(internals.pendingUserMessage).toBeNull();
    expect(sent).toEqual([]);

    const { sends } = injectHandle(conn);
    await internals.flushPendingUserMessage();
    expect(sends).toEqual([]);
  });

  it("keeps only the latest pending user-message (single slot)", async () => {
    const { conn } = harness();
    const internals = conn as unknown as ConnInternals;

    await conn.onClientMessage(
      JSON.stringify({ type: "user-message", text: "first" }),
    );
    await conn.onClientMessage(
      JSON.stringify({ type: "user-message", text: "second" }),
    );
    expect(internals.pendingUserMessage).toEqual({
      type: "user-message",
      text: "second",
    });

    const { sends } = injectHandle(conn);
    await internals.flushPendingUserMessage();
    expect(sends).toEqual([{ text: "second", opts: {} }]);
  });

  it("forwards cancel mid-turn even while sending is latched", async () => {
    const cancelCalls: number[] = [];
    const { conn } = harness();
    injectHandle(conn, {
      cancelTurn: () => cancelCalls.push(1),
    });
    (conn as unknown as ConnInternals).sending = true;

    await conn.onClientMessage(JSON.stringify({ type: "cancel" }));

    expect(cancelCalls).toEqual([1]);
  });
});

describe("ChatConnection attachments", () => {
  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  function connectedHarness(caps: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  }) {
    const sent: string[] = [];
    const ws = {
      send: (data: string) => sent.push(data),
      close: () => {},
    } as unknown as WSContext;
    const conn = new ChatConnection(ws, stepTarget, {} as ChatWsDeps);
    const { sends } = injectHandle(conn, {
      getPromptCapabilities: () => ({
        image: caps.image === true,
        audio: caps.audio === true,
        embeddedContext: caps.embeddedContext === true,
      }),
    });
    return { sent, sends, conn };
  }

  it("forwards accepted image attachments", async () => {
    const { sent, sends, conn } = connectedHarness({ image: true });
    await conn.onClientMessage(
      JSON.stringify({
        type: "user-message",
        text: "see",
        attachments: [
          { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
        ],
      }),
    );
    expect(sends).toEqual([
      {
        text: "see",
        opts: {
          attachments: [
            { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
          ],
        },
      },
    ]);
    expect(sent).toEqual([]);
  });

  it("surfaces bridge errors for rejected attachments", async () => {
    const { sent, sends, conn } = connectedHarness({});
    (
      conn as unknown as {
        handle: { sendMessage: () => Promise<void> };
      }
    ).handle.sendMessage = async () => {
      throw new Error(
        'Attachments are not supported by this agent session (rejected "image/png").',
      );
    };
    await conn.onClientMessage(
      JSON.stringify({
        type: "user-message",
        text: "see",
        attachments: [
          { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
        ],
      }),
    );
    expect(sends).toEqual([]);
    expect(sent.map((s) => JSON.parse(s) as unknown)).toEqual([
      {
        type: "error",
        error: expect.stringMatching(/not supported|does not accept image/i),
      },
    ]);
  });

  it("allows attachment-only turns", async () => {
    const { sends, conn } = connectedHarness({ image: true });
    await conn.onClientMessage(
      JSON.stringify({
        type: "user-message",
        text: "   ",
        attachments: [
          { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
        ],
      }),
    );
    expect(sends[0]?.text).toBe("");
    expect(sends[0]?.opts?.attachments).toHaveLength(1);
  });
});

describe("ChatConnection thread target", () => {
  it("answers ping on a thread connection before ACP is ready", async () => {
    const sent: string[] = [];
    const ws = {
      send: (data: string) => sent.push(data),
      close: () => {},
    } as unknown as WSContext;
    const conn = new ChatConnection(
      ws,
      { kind: "thread", ref: { threadId: "t1" } },
      {} as ChatWsDeps,
    );

    await conn.onClientMessage(JSON.stringify({ type: "ping", id: "tp" }));

    expect(sent.map((s) => JSON.parse(s) as unknown)).toEqual([
      { type: "pong", id: "tp" },
    ]);
  });

  it("seeds ready from warm mid-turn messages instead of a stale disk transcript", async () => {
    const sent: string[] = [];
    const ws = {
      send: (data: string) => sent.push(data),
      close: () => {},
    } as unknown as WSContext;

    const warmUser = {
      id: "u1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Still running" }],
    };
    const diskOnly = [] as typeof warmUser[];

    const deps = {
      sessions: {
        claim: () => {},
        release: () => {},
        isAiWorking: () => true,
        peekWarmMessages: () => [warmUser],
        acquire: async () => {
          throw new Error("should not open for this ready assertion");
        },
      },
      chatThreads: {
        getThread: () => ({ id: "t1" }),
        loadBranchable: () => ({ messages: {}, activeHeadId: null }),
        loadTranscript: () => diskOnly,
      },
      projectCwd: "/tmp/repo",
      spawn: () => {
        throw new Error("no spawn");
      },
    } as unknown as ChatWsDeps;

    const conn = new ChatConnection(
      ws,
      { kind: "thread", ref: { threadId: "t1" } },
      deps,
    );

    // start() sends ready before openChat; openChat will fail — we only care about ready.
    await conn.start();

    const ready = sent
      .map((s) => JSON.parse(s) as { type: string; messages?: unknown; streaming?: boolean })
      .find((m) => m.type === "ready");
    expect(ready).toEqual(
      expect.objectContaining({
        type: "ready",
        streaming: true,
        messages: [warmUser],
      }),
    );
  });
});
