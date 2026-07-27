import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import { finalizeSpecAssistTurn } from "../chat/finalize-spec-assist.js";
import type { StepKey } from "../pipelines.js";
import { projectStoreExchangePath } from "../project-store.js";
import type { InteractivePermissionPolicy } from "./chat.js";
import { buildGrillOpeningPrompt } from "./grill-prompt.js";
import { buildSpecAssistOpeningPrompt } from "./spec-assist-prompt.js";

export type OpeningPromptCard = { title: string; description: string };

export type ChatStepProfile = {
  interactivePermissionPolicy?: InteractivePermissionPolicy;
  /** Spec assist needs the settled Grill session in its opening prompt. */
  needsGrillSession?: boolean;
  resolveOpeningPrompt: (ctx: {
    card: OpeningPromptCard;
    cwd: string;
    promptsRoot: string;
    cardId: string;
    grillSession?: string;
  }) => string;
  /** Optional turn-finalizer (e.g. Spec-assist harvest). */
  onTurnComplete?: (ctx: {
    cardId: string;
    artifacts: ArtifactStore;
    storeRoot: string;
    send: (msg: { type: "spec-revised"; markdown: string }) => void;
    sendError: (error: string) => void;
    isClosed: () => boolean;
  }) => void;
};

const grillProfile: ChatStepProfile = {
  resolveOpeningPrompt: ({ card, cwd, promptsRoot }) =>
    buildGrillOpeningPrompt(
      {
        title: card.title,
        description: card.description,
        contextPath: path.join(cwd, "CONTEXT.md"),
      },
      promptsRoot,
    ),
};

const specProfile: ChatStepProfile = {
  interactivePermissionPolicy: "cursor-like",
  needsGrillSession: true,
  resolveOpeningPrompt: ({ card, cwd, promptsRoot, cardId, grillSession }) =>
    buildSpecAssistOpeningPrompt(
      {
        title: card.title,
        description: card.description,
        contextPath: path.join(cwd, "CONTEXT.md"),
        grillSession: grillSession ?? "",
        exchangePath: projectStoreExchangePath(cardId, "spec.md"),
      },
      promptsRoot,
    ),
  onTurnComplete: ({ cardId, artifacts, storeRoot, send, sendError, isClosed }) => {
    try {
      const result = finalizeSpecAssistTurn({ artifacts, storeRoot, cardId });
      if (result.kind === "revision" && !isClosed()) {
        send({ type: "spec-revised", markdown: result.markdown });
      }
    } catch (err) {
      if (isClosed()) return;
      sendError(err instanceof Error ? err.message : String(err));
    }
  },
};

const PROFILES: Partial<Record<StepKey, ChatStepProfile>> = {
  grill: grillProfile,
  spec: specProfile,
};

/** Per-step chat policy — openChat / ChatConnection stay framing-only. */
export function chatStepProfile(stepKey: StepKey): ChatStepProfile {
  const profile = PROFILES[stepKey];
  if (!profile) {
    throw new Error(`no opening prompt for step: ${stepKey}`);
  }
  return profile;
}
