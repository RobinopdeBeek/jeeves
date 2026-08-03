import type {
  BranchableTranscript,
  RewindOp,
} from "../../shared/branchable-transcript.js";
import type { ChatThreadStore } from "../chat-threads/store.js";
import type { SpawnAcp } from "./chat.js";
import {
  createProjectChatSession,
  threadChatSessionId,
} from "./chat-session.js";
import { openChat, type OpenChatResult } from "./open-chat.js";
import type { ChatSessionRegistry } from "./session-registry.js";

export type { RewindOp } from "../../shared/branchable-transcript.js";

export interface RewindProjectChatDeps {
  threads: ChatThreadStore;
  spawn: SpawnAcp;
  sessions: ChatSessionRegistry;
  /** Main Project checkout cwd. */
  cwd: string;
}

export interface RewindProjectChatResult extends OpenChatResult {
  branchable: BranchableTranscript;
}

/**
 * Truncate/switch the Chat Thread transcript, kill its warm ACP, respawn, and
 * return a handle whose next user turn seed-onces from the rewound path only.
 */
export async function rewindProjectChat(
  threadId: string,
  op: RewindOp,
  deps: RewindProjectChatDeps,
): Promise<RewindProjectChatResult> {
  if (!deps.threads.getThread(threadId)) {
    throw new Error("thread not found");
  }

  if (op.action === "truncate") {
    deps.threads.truncateTranscript(threadId, op.headId);
  } else {
    deps.threads.switchTranscriptBranch(threadId, op.branchId);
  }

  deps.sessions.close(threadChatSessionId(threadId), "rewound");

  const session = createProjectChatSession(
    { threadId },
    { threads: deps.threads, cwd: deps.cwd },
  );
  const opened = await openChat(session, {
    spawn: deps.spawn,
    sessions: deps.sessions,
  });

  return {
    history: opened.history,
    handle: opened.handle,
    branchable: deps.threads.loadBranchable(threadId),
  };
}
