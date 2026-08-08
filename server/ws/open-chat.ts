import type { UIMessage } from "ai";
import type { StepKey } from "../pipelines.js";
import type { ChatSession, CreateStepChatSessionDeps } from "./chat-session.js";
import { createStepChatSession } from "./chat-session.js";
import type { SpawnAcp } from "./chat.js";
import { chatStepProfile } from "./chat-step-profile.js";
import {
  ChatSessionRegistry,
  type WarmSessionHandle,
} from "./session-registry.js";

export {
  createProjectChatSession,
  createStepChatSession,
  loadGrillSession,
  loadSpecMarkdown,
  loadTranscript,
  stepChatSessionId,
  stepChatSessionIdFromRef,
  threadChatSessionId,
  type ChatSession,
  type ChatSessionId,
  type ProjectChatRef,
  type StepChatRef,
} from "./chat-session.js";

export interface OpenChatDeps extends CreateStepChatSessionDeps {
  spawn: SpawnAcp;
  sessions: ChatSessionRegistry;
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

/**
 * Open or reattach a warm ACP chat from a resolved ChatSession descriptor.
 * Registry acquire wires live callbacks from the session itself.
 */
export async function openChat(
  session: ChatSession,
  deps: Pick<OpenChatDeps, "spawn" | "sessions">,
): Promise<OpenChatResult> {
  const history = session.loadTranscript();
  const handle = await deps.sessions.acquire(session, { spawn: deps.spawn });
  return { history, handle };
}

/**
 * Convenience for tests and call sites that still have a step ref + full deps.
 * Prefer resolving ChatSession at the WS boundary in production adapters.
 */
export async function openStepChat(
  ref: { cardId: string; stepKey: StepKey; round: number },
  deps: OpenChatDeps,
  hooks: {
    onStatusNotify?: (status: "ai-working" | "needs-user") => void;
    onTurnComplete?: () => void;
  } = {},
): Promise<OpenChatResult> {
  const session = createStepChatSession(ref, deps, hooks);
  return openChat(session, deps);
}
