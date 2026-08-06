import type { UIMessage } from "ai";
import type { BranchableTranscript } from "../../shared/branchable-transcript.js";
import type { ChatAttachment } from "../../shared/prompt-capabilities.js";
import {
  materializeAttachments,
  resolveAttachmentBytesForOwner,
} from "../attachments/store.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import {
  EMPTY_DRAFT_TITLE,
  type ChatThreadStore,
} from "../chat-threads/store.js";
import type { EventBus } from "../execution/events.js";
import { AUTO_MODEL_VALUE } from "../models/list-models.js";
import type { StepKey } from "../pipelines.js";
import { resolveProjectStorePaths } from "../project-store.js";
import type { AcpLiveCallbacks, InteractivePermissionPolicy } from "./chat.js";
import {
  chatStepProfile,
  stripAnyAssistFrame,
  type ChatTurnRevisionMessage,
} from "./chat-step-profile.js";

/**
 * Opaque warm-registry id. Server-built only — clients send card/step/round
 * (or thread id) and the WS boundary mints this string.
 */
export type ChatSessionId = string;

/** Client-facing step-chat coordinates resolved at the WS boundary. */
export interface StepChatRef {
  cardId: string;
  stepKey: StepKey;
  round: number;
}

/** Client-facing Project Chat Thread coordinates resolved at the WS boundary. */
export interface ProjectChatRef {
  threadId: string;
}

/**
 * Card/step/thread-agnostic descriptor for one warm ACP chat.
 * Registry and bridge see only `id` plus the injected policies/callbacks.
 */
export interface ChatSession {
  id: ChatSessionId;
  cwd: string;
  /** Null = warm without auto agent turn (Project Chat). */
  openingPrompt: string | null;
  /**
   * Pinned model for Project Chat, applied to the live session via
   * `session/set_config_option`; omit/null = the agent's Auto (board step chats).
   * May hold a legacy bare id — resolved against the agent's option list.
   */
  model?: string | null;
  loadTranscript(): UIMessage[];
  saveTranscript(messages: UIMessage[]): void;
  assertMutable(): void;
  notifyStatus(status: "ai-working" | "needs-user"): void;
  interactivePermissionPolicy?: InteractivePermissionPolicy;
  frameUserMessage?: AcpLiveCallbacks["frameUserMessage"];
  onTurnComplete?: AcpLiveCallbacks["onTurnComplete"];
  /** The agent switched model itself — persist so the picker follows. */
  onModelChanged?: AcpLiveCallbacks["onModelChanged"];
  /** Rewrite live `data:` attachments to sidecars before transcript persist. */
  persistAttachments?: (
    attachments: ChatAttachment[],
  ) => ChatAttachment[];
  /** Resolve pointer / data: URL → base64 for ACP ContentBlocks. */
  resolveAttachmentBytes?: (att: ChatAttachment) => {
    mimeType: string;
    data: string;
  };
}

/** Server-built opaque id for a card step chat. */
export function stepChatSessionId(
  cardId: string,
  stepKey: StepKey,
  round: number,
): ChatSessionId {
  return `card:${cardId}:${stepKey}:${round}`;
}

export function stepChatSessionIdFromRef(ref: StepChatRef): ChatSessionId {
  return stepChatSessionId(ref.cardId, ref.stepKey, ref.round);
}

/** Server-built opaque id for a Project Chat Thread. */
export function threadChatSessionId(threadId: string): ChatSessionId {
  return `thread:${threadId}`;
}

export function loadTranscript(
  artifacts: ArtifactStore,
  ref: StepChatRef,
): UIMessage[] {
  const row = artifacts.latest(ref.cardId, {
    stepKey: ref.stepKey,
    round: ref.round,
    kind: "transcript",
  });
  if (!row) return [];
  try {
    const parsed = JSON.parse(artifacts.readContent(row)) as UIMessage[];
    if (!Array.isArray(parsed)) return [];
    // Older assist turns may have stored framed draft bodies in user parts —
    // strip for display so chat stays readable.
    return parsed.map(stripFramedUserParts);
  } catch {
    return [];
  }
}

function stripFramedUserParts(message: UIMessage): UIMessage {
  if (message.role !== "user") return message;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "text"
        ? { ...part, text: stripAnyAssistFrame(part.text) }
        : part,
    ),
  };
}

/** Settled Grill session Q&A for Spec side-chat context (ADR 0012). */
export function loadGrillSession(
  artifacts: ArtifactStore,
  cardId: string,
): string {
  const row = artifacts.latest(cardId, {
    stepKey: "grill",
    round: 0,
    kind: "grill",
  });
  if (!row) return "";
  try {
    return artifacts.readContent(row);
  } catch {
    return "";
  }
}

/** Spec markdown body for Tasks side-chat opener. */
export function loadSpecMarkdown(
  artifacts: ArtifactStore,
  cardId: string,
): string {
  const row = artifacts.latest(cardId, {
    stepKey: "spec",
    round: 0,
    kind: "spec",
  });
  if (!row) return "";
  try {
    return artifacts.readBody(row);
  } catch {
    return "";
  }
}

export interface CreateStepChatSessionDeps {
  store: CardStore;
  artifacts: ArtifactStore;
  events: EventBus;
  promptsRoot: string;
}

export interface CreateStepChatSessionHooks {
  onStatusNotify?: (status: "ai-working" | "needs-user") => void;
  /**
   * WS send hooks for Spec/Tasks revision frames. When omitted, profile
   * onTurnComplete is not wired (e.g. openChat unit tests).
   */
  onTurnComplete?: AcpLiveCallbacks["onTurnComplete"];
}

/**
 * Resolve Grill / Spec assist / Tasks assist into a ChatSession at the WS boundary.
 */
export function createStepChatSession(
  ref: StepChatRef,
  deps: CreateStepChatSessionDeps,
  hooks: CreateStepChatSessionHooks = {},
): ChatSession {
  const card = deps.store.getCard(ref.cardId);
  if (!card) throw new Error("card not found");

  const profile = chatStepProfile(ref.stepKey);
  const cwd = deps.store.getRepoPath(ref.cardId);
  const openingPrompt = profile.resolveOpeningPrompt({
    card,
    cwd,
    promptsRoot: deps.promptsRoot,
    cardId: ref.cardId,
    grillSession: profile.needsGrillSession
      ? loadGrillSession(deps.artifacts, ref.cardId)
      : undefined,
    spec: profile.needsSpec
      ? loadSpecMarkdown(deps.artifacts, ref.cardId)
      : undefined,
  });

  const attachmentOwner = {
    kind: "step" as const,
    artifactRoot: deps.artifacts.root,
    cardId: ref.cardId,
    stepKey: ref.stepKey,
  };

  return {
    id: stepChatSessionIdFromRef(ref),
    cwd,
    openingPrompt,
    loadTranscript: () => loadTranscript(deps.artifacts, ref),
    saveTranscript: (messages) => {
      deps.artifacts.upsertTranscript(
        ref.cardId,
        ref.stepKey,
        ref.round,
        messages,
      );
    },
    assertMutable: () => {
      deps.store.assertTranscriptMutable(ref.cardId, ref.stepKey);
    },
    notifyStatus: (status) => {
      const updated = deps.store.setStepStatus(ref.cardId, ref.stepKey, status);
      deps.events.emit({ type: "card.updated", card: updated });
      hooks.onStatusNotify?.(status);
    },
    interactivePermissionPolicy: profile.interactivePermissionPolicy,
    frameUserMessage: profile.frameUserMessage,
    onTurnComplete: hooks.onTurnComplete,
    persistAttachments: (attachments) =>
      materializeAttachments(attachmentOwner, attachments),
    resolveAttachmentBytes: (att) => {
      const resolved = resolveAttachmentBytesForOwner(attachmentOwner, att);
      return { mimeType: resolved.mimeType, data: resolved.data };
    },
  };
}

export interface CreateProjectChatSessionDeps {
  threads: ChatThreadStore;
  /** Main Project checkout cwd (not a worktree). */
  cwd: string;
  /**
   * Fired after each Project Chat transcript save with the updated tree.
   * WS attach uses this to push `branchable` so sibling pickers update live.
   */
  onBranchableUpdated?: (branchable: BranchableTranscript) => void;
}

/**
 * Resolve a Project Chat Thread into a ChatSession at the WS boundary.
 * Null opening prompt = warm ACP with no assistant opening monologue.
 */
export function createProjectChatSession(
  ref: ProjectChatRef,
  deps: CreateProjectChatSessionDeps,
): ChatSession {
  const thread = deps.threads.getThread(ref.threadId);
  if (!thread) throw new Error("thread not found");

  const attachmentOwner = {
    kind: "chat" as const,
    chatRoot: deps.threads.root,
    threadId: ref.threadId,
  };

  return {
    id: threadChatSessionId(ref.threadId),
    cwd: deps.cwd,
    openingPrompt: null,
    model: thread.model,
    loadTranscript: () => deps.threads.loadTranscript(ref.threadId),
    saveTranscript: (messages) => {
      deps.threads.saveTranscript(ref.threadId, messages);
      deps.onBranchableUpdated?.(
        deps.threads.loadBranchable(ref.threadId),
      );
    },
    assertMutable: () => {
      if (!deps.threads.getThread(ref.threadId)) {
        throw new Error("thread not found");
      }
    },
    // Project Chat has no board step status column.
    notifyStatus: () => {},
    interactivePermissionPolicy: "project-chat",
    onModelChanged: (value) => {
      // Auto is stored as an unpinned thread, not as the literal config value.
      deps.threads.setModel(
        ref.threadId,
        value === AUTO_MODEL_VALUE ? null : value,
      );
    },
    onTurnComplete: () => {
      maybeAutoTitleFromFirstUserMessage(
        deps.threads,
        ref.threadId,
        deps.threads.loadTranscript(ref.threadId),
      );
    },
    persistAttachments: (attachments) =>
      materializeAttachments(attachmentOwner, attachments),
    resolveAttachmentBytes: (att) => {
      const resolved = resolveAttachmentBytesForOwner(attachmentOwner, att);
      return { mimeType: resolved.mimeType, data: resolved.data };
    },
  };
}

const AUTO_TITLE_MAX = 60;

function maybeAutoTitleFromFirstUserMessage(
  threads: ChatThreadStore,
  threadId: string,
  messages: UIMessage[],
): void {
  const current = threads.getThread(threadId);
  if (!current || current.title !== EMPTY_DRAFT_TITLE) return;
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return;
  const text = firstUser.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return;
  const title =
    text.length <= AUTO_TITLE_MAX
      ? text
      : `${text.slice(0, AUTO_TITLE_MAX - 1).trimEnd()}…`;
  threads.renameThread(threadId, title);
}

/** Wire Spec/Tasks profile onTurnComplete to WS send callbacks. */
export function stepChatTurnCompleteHook(
  ref: StepChatRef,
  deps: CreateStepChatSessionDeps,
  send: {
    send: (msg: ChatTurnRevisionMessage) => void;
    sendError: (error: string) => void;
    isClosed: () => boolean;
  },
): (() => void) | undefined {
  const profile = chatStepProfile(ref.stepKey);
  if (!profile.onTurnComplete) return undefined;
  return () => {
    const repoPath = deps.store.getRepoPath(ref.cardId);
    const storeRoot = resolveProjectStorePaths(repoPath).storeRoot;
    profile.onTurnComplete!({
      cardId: ref.cardId,
      artifacts: deps.artifacts,
      storeRoot,
      send: send.send,
      sendError: send.sendError,
      isClosed: send.isClosed,
    });
  };
}
