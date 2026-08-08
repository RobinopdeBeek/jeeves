import type { UIMessage } from "ai";
import type {
  BranchableTranscript,
  RewindOp,
} from "../../shared/branchable-transcript.js";
import type { ChatThread } from "../db/schema.js";
import {
  ChatThreadStoreError,
  type ChatThreadStore,
} from "../chat-threads/store.js";
import type { SpawnAcp } from "./chat.js";
import {
  createProjectChatSession,
  threadChatSessionId,
} from "./chat-session.js";
import { openChat } from "./open-chat.js";
import type { ChatSessionRegistry, WarmSessionHandle } from "./session-registry.js";

export type { RewindOp } from "../../shared/branchable-transcript.js";

export interface ProjectChatDeps {
  threads: ChatThreadStore;
  spawn: SpawnAcp;
  sessions: ChatSessionRegistry;
  /** Main Project checkout cwd. */
  cwd: string;
}

/** Durable Rewind succeeded; warm ACP may or may not have respawned. */
export type WarmOutcome =
  | { status: "open"; handle: WarmSessionHandle }
  | { status: "failed"; error: string };

export interface ProjectChatRewindResult {
  messages: UIMessage[];
  branchable: BranchableTranscript;
  warm: WarmOutcome;
}

/**
 * Project Chat lifecycle inside the AcpBridge module: Chat Thread persistence
 * mutations that must also keep the warm registry honest (ADR 0015 / 0016).
 */
export class ProjectChat {
  constructor(private readonly deps: ProjectChatDeps) {}

  /**
   * Pin the model and switch the live session in place via
   * `session/set_config_option` — no respawn, no displacement, conversation
   * preserved. A failed switch leaves the durable pin standing; it is applied
   * the next time the session opens.
   */
  async setModel(
    threadId: string,
    model: string | null,
  ): Promise<ChatThread | undefined> {
    const before = this.deps.threads.getThread(threadId);
    if (!before) return undefined;
    const thread = this.deps.threads.setModel(threadId, model);
    if (!thread) return undefined;
    if (before.model !== thread.model) {
      try {
        await this.deps.sessions.setModel(
          threadChatSessionId(threadId),
          thread.model,
        );
      } catch (e) {
        console.error(
          `chat thread ${threadId} model switch failed: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }
    return thread;
  }

  /**
   * Warm a spare `agent acp` for the Project checkout. Every thread shares that
   * cwd, so one spare covers the whole Chat page.
   */
  prewarm(): void {
    this.deps.sessions.prewarm(this.deps.cwd, this.deps.spawn);
  }

  /** Evict warm ACP, then hard-delete the Chat Thread index + files. */
  deleteThread(threadId: string): boolean {
    if (!this.deps.threads.getThread(threadId)) return false;
    this.deps.sessions.close(threadChatSessionId(threadId), "thread deleted");
    return this.deps.threads.deleteThread(threadId);
  }

  /** True while this thread's warm ACP bridge is mid-turn. */
  isAiWorking(threadId: string): boolean {
    return this.deps.sessions.isAiWorking(threadChatSessionId(threadId));
  }

  /**
   * Truncate/switch the transcript, close warm ACP, attempt respawn.
   * Durable Rewind always stands; warm failure is reported explicitly.
   */
  async rewind(
    threadId: string,
    op: RewindOp,
  ): Promise<ProjectChatRewindResult> {
    if (!this.deps.threads.getThread(threadId)) {
      throw new ChatThreadStoreError(404, "thread not found");
    }

    if (op.action === "truncate") {
      this.deps.threads.truncateTranscript(threadId, op.headId);
    } else {
      this.deps.threads.switchTranscriptBranch(threadId, op.branchId);
    }

    this.deps.sessions.close(threadChatSessionId(threadId), "rewound");

    const branchable = this.deps.threads.loadBranchable(threadId);
    const messages = this.deps.threads.loadTranscript(threadId);

    try {
      const session = createProjectChatSession(
        { threadId },
        { threads: this.deps.threads, cwd: this.deps.cwd },
      );
      const opened = await openChat(session, {
        spawn: this.deps.spawn,
        sessions: this.deps.sessions,
      });
      return {
        messages: opened.history,
        branchable,
        warm: { status: "open", handle: opened.handle },
      };
    } catch (e) {
      return {
        messages,
        branchable,
        warm: {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }
}

/** Convenience for call sites that only need the rewind op (tests / thin wrappers). */
export async function rewindProjectChat(
  threadId: string,
  op: RewindOp,
  deps: ProjectChatDeps,
): Promise<ProjectChatRewindResult> {
  return new ProjectChat(deps).rewind(threadId, op);
}
