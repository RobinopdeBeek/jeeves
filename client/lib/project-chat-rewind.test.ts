import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  fromLinear,
  getBranches,
  syncActivePath,
  truncateTo,
  type BranchableTranscript,
} from "@shared/branchable-transcript";
import {
  createProjectChatBranchAdapter,
  switchOpForBranch,
  truncateOpForEdit,
} from "./project-chat-rewind";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function twoBranchTree(): BranchableTranscript {
  const base = fromLinear([
    msg("u1", "user", "v1"),
    msg("a1", "assistant", "r1"),
  ]);
  const truncated = truncateTo(base, null);
  return syncActivePath(truncated, [
    msg("u2", "user", "v2"),
    msg("a2", "assistant", "r2"),
  ]);
}

describe("project-chat-rewind", () => {
  it("maps an edit to a truncate rewind at the edited message's parent", () => {
    const t = fromLinear([
      msg("u1", "user", "first"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "second"),
      msg("a2", "assistant", "reply2"),
    ]);

    expect(truncateOpForEdit(t, "u1")).toEqual({
      action: "truncate",
      headId: null,
    });
    expect(truncateOpForEdit(t, "u2")).toEqual({
      action: "truncate",
      headId: "a1",
    });
  });

  it("maps a branch pick to a switch rewind op", () => {
    expect(switchOpForBranch("u1")).toEqual({
      action: "switch",
      branchId: "u1",
    });
  });

  it("exposes sibling branch ids and forwards switchToBranch", () => {
    const tree = twoBranchTree();
    const onSwitchBranch = vi.fn();
    const adapter = createProjectChatBranchAdapter({
      getBranchable: () => tree,
      onSwitchBranch,
    });

    expect(adapter.getBranches("u2").sort()).toEqual(["u1", "u2"]);
    expect(adapter.getBranches("missing")).toEqual([]);

    adapter.switchToBranch("u1");
    expect(onSwitchBranch).toHaveBeenCalledWith("u1");
  });

  it("hides the branch picker when the UI message id is not in the tree", () => {
    // Live UI keeps client ids; branchable must use the same ids or
    // getBranches returns [] and the picker stays hidden until remount.
    const tree = twoBranchTree();
    expect(getBranches(tree, "some-other-client-id")).toEqual([]);
    expect(getBranches(tree, "u2").sort()).toEqual(["u1", "u2"]);
  });
});
