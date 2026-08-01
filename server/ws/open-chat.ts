import type { UIMessage } from "ai";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { EventBus } from "../execution/events.js";
import type { StepKey } from "../pipelines.js";
import type { SpawnAcp } from "./chat.js";
import { chatStepProfile, stripAnyAssistFrame } from "./chat-step-profile.js";
import {
  ChatSessionRegistry,
  type SessionKey,
  type WarmSessionHandle,
} from "./session-registry.js";

export interface OpenChatDeps {
  store: CardStore;
  artifacts: ArtifactStore;
  events: EventBus;
  spawn: SpawnAcp;
  promptsRoot: string;
  sessions: ChatSessionRegistry;
}

export interface OpenChatOptions {
  /** Extra notify after CardStore write (e.g. WS status frame). */
  onStatusNotify?: (status: "ai-working" | "needs-user") => void;
  /** After a completed turn (step profile may supply its own via attach). */
  onTurnComplete?: () => void;
}

export interface OpenChatResult {
  history: UIMessage[];
  handle: WarmSessionHandle;
}

/** Step-keyed opening prompt for AI Chat steps. */
export function resolveOpeningPrompt(
  stepKey: StepKey,
  card: { title: string; description: string },
  cwd: string,
  promptsRoot: string,
  extras: {
    cardId: string;
    grillSession?: string;
    spec?: string;
  } = { cardId: "" },
): string {
  return chatStepProfile(stepKey).resolveOpeningPrompt({
    card,
    cwd,
    promptsRoot,
    cardId: extras.cardId,
    grillSession: extras.grillSession,
    spec: extras.spec,
  });
}

export function loadTranscript(
  artifacts: ArtifactStore,
  key: SessionKey,
): UIMessage[] {
  const row = artifacts.latest(key.cardId, {
    stepKey: key.stepKey,
    round: key.round,
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

function stripAssistFrame(text: string): string {
  return stripAnyAssistFrame(text);
}

function stripFramedUserParts(message: UIMessage): UIMessage {
  if (message.role !== "user") return message;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "text"
        ? { ...part, text: stripAssistFrame(part.text) }
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

/**
 * Open or reattach a warm ACP chat for (card, step, round).
 * Owns prompt resolution, status writes, and transcript upsert — WS stays framing-only.
 */
export async function openChat(
  key: SessionKey,
  deps: OpenChatDeps,
  options: OpenChatOptions = {},
): Promise<OpenChatResult> {
  const card = deps.store.getCard(key.cardId);
  if (!card) throw new Error("card not found");

  deps.store.assertTranscriptMutable(key.cardId, key.stepKey);

  const profile = chatStepProfile(key.stepKey);
  const history = loadTranscript(deps.artifacts, key);
  const cwd = deps.store.getRepoPath(key.cardId);
  const openingPrompt = profile.resolveOpeningPrompt({
    card,
    cwd,
    promptsRoot: deps.promptsRoot,
    cardId: key.cardId,
    grillSession: profile.needsGrillSession
      ? loadGrillSession(deps.artifacts, key.cardId)
      : undefined,
    spec: profile.needsSpec
      ? loadSpecMarkdown(deps.artifacts, key.cardId)
      : undefined,
  });

  const handle = await deps.sessions.acquire(key, {
    spawn: deps.spawn,
    cwd,
    openingPrompt,
    history,
    interactivePermissionPolicy: profile.interactivePermissionPolicy,
    onStatus: (status) => {
      const updated = deps.store.setStepStatus(key.cardId, key.stepKey, status);
      deps.events.emit({ type: "card.updated", card: updated });
      options.onStatusNotify?.(status);
    },
    onTranscript: (messages) => {
      deps.store.assertTranscriptMutable(key.cardId, key.stepKey);
      deps.artifacts.upsertTranscript(key.cardId, key.stepKey, key.round, messages);
    },
    onTurnComplete: options.onTurnComplete,
    frameUserMessage: profile.frameUserMessage,
  });

  return { history, handle };
}
