import type { UIMessage } from "ai";

/** One node in a branch-aware transcript tree. */
export type BranchNode = {
  parentId: string | null;
  message: UIMessage;
};

/**
 * Server-owned branch-aware transcript: message tree + active head.
 * Active path (root → head) is what ACP seed-once and WS `ready` use.
 */
export type BranchableTranscript = {
  version: 1;
  headId: string | null;
  messages: BranchNode[];
};

/** POST /api/chat-threads/:id/rewind body. */
export type RewindOp =
  | { action: "truncate"; headId: string | null }
  | { action: "switch"; branchId: string };
