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
