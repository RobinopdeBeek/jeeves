import type { WSContext } from "hono/ws";
import { describe, expect, it } from "vitest";
import { ChatConnection, type ChatWsDeps } from "./attach.js";

const stepTarget = {
  kind: "step" as const,
  ref: { cardId: "c1", stepKey: "grill" as const, round: 0 },
};

function harness() {
  const sent: string[] = [];
  const ws = {
    send: (data: string) => sent.push(data),
    close: () => {},
  } as unknown as WSContext;
  // Liveness is answered before openChat runs, so no deps are touched.
  return { sent, conn: new ChatConnection(ws, stepTarget, {} as ChatWsDeps) };
}

describe("ChatConnection liveness", () => {
  it("answers ping with pong while the ACP session is still starting", async () => {
    const { sent, conn } = harness();

    await conn.onClientMessage(JSON.stringify({ type: "ping", id: "p1" }));

    expect(sent.map((s) => JSON.parse(s) as unknown)).toEqual([
      { type: "pong", id: "p1" },
    ]);
  });

  it("ignores user turns until a session handle is attached", async () => {
    const { sent, conn } = harness();

    await conn.onClientMessage(JSON.stringify({ type: "user-message", text: "hi" }));

    expect(sent).toEqual([]);
  });

  it("forwards cancel mid-turn even while sending is latched", async () => {
    const cancelCalls: number[] = [];
    const { conn } = harness();
    // Inject a handle the way start() would after openChat.
    (
      conn as unknown as {
        handle: {
          cancelTurn: () => void;
          sendMessage: () => Promise<void>;
          respondToPermission: () => void;
          attach: () => void;
          detach: () => void;
          getPendingPermissionIds: () => string[];
        };
        sending: boolean;
      }
    ).handle = {
      cancelTurn: () => cancelCalls.push(1),
      sendMessage: async () => {},
      respondToPermission: () => {},
      attach: () => {},
      detach: () => {},
      getPendingPermissionIds: () => [],
    };
    (conn as unknown as { sending: boolean }).sending = true;

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
    const sends: Array<{
      text: string;
      opts?: { liveDraftBody?: string; attachments?: unknown };
    }> = [];
    const conn = new ChatConnection(ws, stepTarget, {} as ChatWsDeps);
    (
      conn as unknown as {
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
        };
      }
    ).handle = {
      cancelTurn: () => {},
      sendMessage: async (text, opts) => {
        sends.push({ text, opts });
      },
      respondToPermission: () => {},
      attach: () => {},
      detach: () => {},
      getPendingPermissionIds: () => [],
      getPromptCapabilities: () => ({
        image: caps.image === true,
        audio: caps.audio === true,
        embeddedContext: caps.embeddedContext === true,
      }),
    };
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

  it("rejects unsupported attachments with a clear error", async () => {
    const { sent, sends, conn } = connectedHarness({});
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
});
