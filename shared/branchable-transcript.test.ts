import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  activePath,
  emptyTranscript,
  fromLinear,
  getBranches,
  parseTranscriptFile,
  parentIdOf,
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

describe("BranchableTranscript (shared)", () => {
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
    expect(parseTranscriptFile(branched).headId).toBe("u2");
  });

  it("fails closed on unknown version, bad nodes, cycles, and missing head", () => {
    expect(() => parseTranscriptFile({ version: 2 })).toThrow(/version/i);
    expect(() =>
      parseTranscriptFile({
        version: 1,
        headId: null,
        messages: [{ parentId: null, message: { id: "x" } }],
      }),
    ).toThrow(/role/i);
    expect(() =>
      parseTranscriptFile({
        version: 1,
        headId: "missing",
        messages: [{ parentId: null, message: msg("u1", "user", "a") }],
      }),
    ).toThrow(/headId/i);
    expect(() =>
      parseTranscriptFile({
        version: 1,
        headId: "a",
        messages: [
          { parentId: "b", message: msg("a", "user", "a") },
          { parentId: "a", message: msg("b", "assistant", "b") },
        ],
      }),
    ).toThrow(/cycle/i);
    expect(() =>
      parseTranscriptFile({
        version: 1,
        headId: "u1",
        messages: [
          { parentId: null, message: msg("u1", "user", "a") },
          { parentId: null, message: msg("u1", "user", "dup") },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("reports parentIdOf for edit truncate and lists sibling branches", () => {
    const t = fromLinear([
      msg("u1", "user", "v1"),
      msg("a1", "assistant", "r1"),
      msg("u2", "user", "v2"),
    ]);
    expect(parentIdOf(t, "u1")).toBeNull();
    expect(parentIdOf(t, "u2")).toBe("a1");
    expect(parentIdOf(t, "missing")).toBeNull();

    const truncated = truncateTo(t, "a1");
    const forked = syncActivePath(truncated, [
      msg("u1", "user", "v1"),
      msg("a1", "assistant", "r1"),
      msg("u3", "user", "v3"),
    ]);
    expect(getBranches(forked, "u3").sort()).toEqual(["u2", "u3"]);

    const switched = switchToBranch(forked, "u2");
    expect(activePath(switched).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });
});
