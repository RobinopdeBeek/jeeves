import type { UIMessage } from "ai";
import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import type { CardStore } from "../cards/store.js";
import type { EventBus } from "../execution/events.js";
import type { StepKey } from "../pipelines.js";
import type { SpawnAcp } from "./chat.js";
import { buildGrillOpeningPrompt } from "./grill-prompt.js";
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
): string {
  if (stepKey === "grill") {
    return buildGrillOpeningPrompt(
      {
        title: card.title,
        description: card.description,
        contextPath: path.join(cwd, "CONTEXT.md"),
      },
      promptsRoot,
    );
  }
  throw new Error(`no opening prompt for step: ${stepKey}`);
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

  const history = loadTranscript(deps.artifacts, key);
  const cwd = deps.store.getRepoPath(key.cardId);
  const openingPrompt = resolveOpeningPrompt(
    key.stepKey,
    card,
    cwd,
    deps.promptsRoot,
  );

  const handle = await deps.sessions.acquire(key, {
    spawn: deps.spawn,
    cwd,
    openingPrompt,
    history,
    onStatus: (status) => {
      const updated = deps.store.setStepStatus(key.cardId, key.stepKey, status);
      deps.events.emit({ type: "card.updated", card: updated });
      options.onStatusNotify?.(status);
    },
    onTranscript: (messages) => {
      deps.store.assertTranscriptMutable(key.cardId, key.stepKey);
      deps.artifacts.upsertTranscript(key.cardId, key.stepKey, key.round, messages);
    },
  });

  return { history, handle };
}
