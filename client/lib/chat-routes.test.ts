import { describe, expect, it } from "vitest";
import { resolveBareChatDestination } from "./chat-routes";

describe("resolveBareChatDestination", () => {
  it("shows the mobile thread list on bare /chat", () => {
    expect(resolveBareChatDestination(false, "abc")).toEqual({ kind: "list" });
    expect(resolveBareChatDestination(false, null)).toEqual({ kind: "list" });
  });

  it("restores the last-opened thread on desktop when one exists", () => {
    expect(resolveBareChatDestination(true, "abc")).toEqual({
      kind: "thread",
      threadId: "abc",
    });
  });

  it("stays on an empty desktop chat when nothing was opened", () => {
    expect(resolveBareChatDestination(true, null)).toEqual({ kind: "empty" });
  });
});
