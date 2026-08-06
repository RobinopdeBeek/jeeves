import { describe, expect, it } from "vitest";
import { mergeBusyFromList } from "./chat-thread-rail";
import type { ChatThread } from "./api";

function thread(id: string, aiWorking?: boolean): ChatThread {
  return {
    id,
    projectId: "p1",
    title: id,
    model: null,
    createdAt: "",
    updatedAt: "",
    lastOpenedAt: null,
    aiWorking,
  };
}

describe("mergeBusyFromList", () => {
  it("keeps the active thread busy even when the list briefly reports idle", () => {
    const { busy, settled } = mergeBusyFromList(
      new Set(["a"]),
      [thread("a", false), thread("b", false)],
      "a",
    );
    expect([...busy]).toEqual(["a"]);
    expect(settled).toEqual([]);
  });

  it("settles a background thread and reports it for unread", () => {
    const { busy, settled } = mergeBusyFromList(
      new Set(["a", "b"]),
      [thread("a", false), thread("b", true)],
      "b",
    );
    expect([...busy].sort()).toEqual(["b"]);
    expect(settled).toEqual(["a"]);
  });

  it("picks up server-busy threads the client has not seen yet", () => {
    const { busy, settled } = mergeBusyFromList(
      new Set(),
      [thread("a", true)],
      "b",
    );
    expect([...busy]).toEqual(["a"]);
    expect(settled).toEqual([]);
  });
});
