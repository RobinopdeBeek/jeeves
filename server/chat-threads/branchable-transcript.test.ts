import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  activePath,
  emptyTranscript,
  fromLinear,
  getBranches,
  parseTranscriptFile,
  syncActivePath,
  switchToBranch,
  truncateTo,
  type BranchableTranscript,
} from "./branchable-transcript.js";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

describe("BranchableTranscript", () => {
  it("converts a linear UIMessage[] into a parent-linked tree with a head", () => {
    const t = fromLinear([
      msg("u1", "user", "hello"),
      msg("a1", "assistant", "hi"),
    ]);

    expect(t.version).toBe(1);
    expect(t.headId).toBe("a1");
    expect(t.messages).toEqual([
      { parentId: null, message: msg("u1", "user", "hello") },
      { parentId: "u1", message: msg("a1", "assistant", "hi") },
    ]);
    expect(activePath(t).map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("parses legacy flat arrays and v1 branchable objects", () => {
    expect(parseTranscriptFile([])).toEqual(emptyTranscript());
    expect(
      parseTranscriptFile([msg("u1", "user", "x")]).messages[0]?.message.id,
    ).toBe("u1");

    const branched: BranchableTranscript = {
      version: 1,
      headId: "u2",
      messages: [
        { parentId: null, message: msg("u1", "user", "a") },
        { parentId: null, message: msg("u2", "user", "b") },
      ],
    };
    expect(parseTranscriptFile(branched)).toEqual(branched);
  });

  it("lists sibling branch ids including the message itself", () => {
    let t = fromLinear([
      msg("u1", "user", "first"),
      msg("a1", "assistant", "ok"),
    ]);
    t = truncateTo(t, null);
    t = syncActivePath(t, [msg("u2", "user", "second"), msg("a2", "assistant", "y")]);

    expect(getBranches(t, "u2").sort()).toEqual(["u1", "u2"]);
    expect(getBranches(t, "a2")).toEqual(["a2"]);
  });

  it("truncateTo keeps off-path siblings and shortens the active path", () => {
    let t = fromLinear([
      msg("u1", "user", "v1"),
      msg("a1", "assistant", "r1"),
      msg("u2", "user", "follow-up"),
      msg("a2", "assistant", "r2"),
    ]);
    t = truncateTo(t, "u1");

    expect(activePath(t).map((m) => m.id)).toEqual(["u1"]);
    expect(t.messages.map((n) => n.message.id).sort()).toEqual([
      "a1",
      "a2",
      "u1",
      "u2",
    ]);
  });

  it("switchToBranch selects the tip of a sibling branch", () => {
    let t = fromLinear([
      msg("u1", "user", "v1"),
      msg("a1", "assistant", "r1"),
    ]);
    t = truncateTo(t, null);
    t = syncActivePath(t, [
      msg("u2", "user", "v2"),
      msg("a2", "assistant", "r2"),
    ]);

    t = switchToBranch(t, "u1");
    expect(activePath(t).map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(t.headId).toBe("a1");

    t = switchToBranch(t, "u2");
    expect(activePath(t).map((m) => m.id)).toEqual(["u2", "a2"]);
  });

  it("syncActivePath appends on the current head without dropping siblings", () => {
    let t = fromLinear([msg("u1", "user", "v1"), msg("a1", "assistant", "r1")]);
    t = truncateTo(t, null);
    t = syncActivePath(t, [msg("u2", "user", "v2")]);
    t = syncActivePath(t, [
      msg("u2", "user", "v2"),
      msg("a2", "assistant", "r2"),
    ]);

    expect(activePath(t).map((m) => m.id)).toEqual(["u2", "a2"]);
    expect(getBranches(t, "u2").sort()).toEqual(["u1", "u2"]);
    // Original branch retained
    expect(t.messages.some((n) => n.message.id === "a1")).toBe(true);
  });

  it("syncActivePath updates message content for ids already on the path", () => {
    let t = fromLinear([msg("u1", "user", "v1")]);
    t = syncActivePath(t, [
      msg("u1", "user", "v1"),
      msg("a1", "assistant", "partial"),
    ]);
    t = syncActivePath(t, [
      msg("u1", "user", "v1"),
      msg("a1", "assistant", "complete"),
    ]);

    expect(activePath(t)[1]?.parts).toEqual([
      { type: "text", text: "complete" },
    ]);
    expect(t.messages).toHaveLength(2);
  });
});
