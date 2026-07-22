import { describe, expect, it } from "vitest";
import {
  ChatSessionRegistry,
  sessionKeyString,
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

describe("ChatSessionRegistry", () => {
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
