import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import type { TasksDraft } from "../artifacts/tasks-draft.js";
import { finalizeSpecAssistTurn } from "../chat/finalize-spec-assist.js";
import { finalizeTasksAssistTurn } from "../chat/finalize-tasks-assist.js";
import type { StepKey } from "../pipelines.js";
import { projectStoreExchangePath } from "../project-store.js";
import {
  frameSpecAssistUserMessage,
  stripSpecAssistFrame,
} from "../../shared/spec-assist-frame.js";
import {
  frameTasksAssistUserMessage,
  stripTasksAssistFrame,
} from "../../shared/tasks-assist-frame.js";
import type { InteractivePermissionPolicy } from "./chat.js";
import { buildGrillOpeningPrompt } from "./grill-prompt.js";
import { buildSpecAssistOpeningPrompt } from "./spec-assist-prompt.js";
import { buildTasksAssistOpeningPrompt } from "./tasks-assist-prompt.js";

export type OpeningPromptCard = { title: string; description: string };

export type ChatTurnRevisionMessage =
  | { type: "spec-revised"; markdown: string }
  | {
      type: "tasks-revised";
      draft: TasksDraft;
      versionCount: number;
    };

export type ChatStepProfile = {
  interactivePermissionPolicy?: InteractivePermissionPolicy;
  /** Spec assist needs the settled Grill session in its opening prompt. */
  needsGrillSession?: boolean;
  /** Tasks revise needs the Spec markdown in its opening prompt. */
  needsSpec?: boolean;
  resolveOpeningPrompt: (ctx: {
    card: OpeningPromptCard;
    cwd: string;
    promptsRoot: string;
    cardId: string;
    grillSession?: string;
    spec?: string;
  }) => string;
  /**
   * Frame a user turn with the live draft body for the agent prompt only.
   * Transcript keeps the bare user text.
   */
  frameUserMessage?: (userText: string, liveDraftBody: string) => string;
  /** Strip a framed draft from older transcripts so chat stays readable. */
  stripFrame?: (text: string) => string;
  /** Optional turn-finalizer (e.g. Spec / Tasks assist harvest). */
  onTurnComplete?: (ctx: {
    cardId: string;
    artifacts: ArtifactStore;
    storeRoot: string;
    send: (msg: ChatTurnRevisionMessage) => void;
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
  frameUserMessage: frameSpecAssistUserMessage,
  stripFrame: stripSpecAssistFrame,
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

const tasksProfile: ChatStepProfile = {
  interactivePermissionPolicy: "cursor-like",
  needsSpec: true,
  frameUserMessage: frameTasksAssistUserMessage,
  stripFrame: stripTasksAssistFrame,
  resolveOpeningPrompt: ({ card, cwd, promptsRoot, cardId, spec }) =>
    buildTasksAssistOpeningPrompt(
      {
        title: card.title,
        description: card.description,
        contextPath: path.join(cwd, "CONTEXT.md"),
        spec: spec ?? "",
        exchangePath: projectStoreExchangePath(cardId, "tasks-draft.json"),
      },
      promptsRoot,
    ),
  onTurnComplete: ({ cardId, artifacts, storeRoot, send, sendError, isClosed }) => {
    try {
      const result = finalizeTasksAssistTurn({ artifacts, storeRoot, cardId });
      if (result.kind === "revision" && !isClosed()) {
        send({
          type: "tasks-revised",
          draft: result.draft,
          versionCount: result.versionCount,
        });
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
  tasks: tasksProfile,
};

/** Per-step chat policy — openChat / ChatConnection stay framing-only. */
export function chatStepProfile(stepKey: StepKey): ChatStepProfile {
  const profile = PROFILES[stepKey];
  if (!profile) {
    throw new Error(`no opening prompt for step: ${stepKey}`);
  }
  return profile;
}

/** Strip any known assist frame (older transcripts may mix Spec/Tasks). */
export function stripAnyAssistFrame(text: string): string {
  let out = text;
  for (const profile of Object.values(PROFILES)) {
    if (profile?.stripFrame) out = profile.stripFrame(out);
  }
  return out;
}
