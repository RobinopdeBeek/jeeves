import type {
  BranchableTranscript,
  RewindOp,
} from "@shared/branchable-transcript";
import {
  getBranches,
  parentIdOf,
} from "@shared/branchable-transcript";
import type { ExternalThreadBranchAdapter } from "@assistant-ui/react";

/**
 * Truncate head for editing `editedMessageId`: keep the parent of that
 * message so the next send forks a sibling under the same parent.
 */
export function truncateOpForEdit(
  branchable: BranchableTranscript,
  editedMessageId: string,
): RewindOp {
  return {
    action: "truncate",
    headId: parentIdOf(branchable, editedMessageId),
  };
}

export function switchOpForBranch(branchId: string): RewindOp {
  return { action: "switch", branchId };
}

/**
 * External branch adapter for Project Chat: sibling ids from the server
 * branchable transcript; switches are delegated to the host (rewind + remount).
 */
export function createProjectChatBranchAdapter(opts: {
  getBranchable: () => BranchableTranscript;
  onSwitchBranch: (branchId: string) => void;
}): ExternalThreadBranchAdapter {
  return {
    getBranches: (messageId) => getBranches(opts.getBranchable(), messageId),
    switchToBranch: (branchId) => {
      opts.onSwitchBranch(branchId);
    },
  };
}
