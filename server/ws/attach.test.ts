import type { WSContext } from "hono/ws";
import { describe, expect, it } from "vitest";
import { ChatConnection, type ChatWsDeps, type SessionKey } from "./attach.js";

const key: SessionKey = { cardId: "c1", stepKey: "grill", round: 0 };

function harness() {
  const sent: string[] = [];
  const ws = {
    send: (data: string) => sent.push(data),
    close: () => {},
  } as unknown as WSContext;
  // Liveness is answered before openChat runs, so no deps are touched.
  return { sent, conn: new ChatConnection(ws, key, {} as ChatWsDeps) };
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
});
