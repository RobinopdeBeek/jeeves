import type { UIMessage } from "ai";
import { Agent, type LocalAgentOptions } from "@cursor/sdk";
import {
  buildGrillSessionPrompt,
  normalizeGrillSessionBody,
  serializeTranscriptForExtract,
} from "../ws/grill-session.js";

const MODEL = "composer-2.5";

export class GrillSessionExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrillSessionExtractError";
  }
}

export interface ExtractGrillSessionInput {
  transcript: UIMessage[];
  repoPath: string;
  promptsRoot: string;
  apiKey?: string;
}

export type ExtractGrillSession = (
  input: ExtractGrillSessionInput,
) => Promise<string>;

function localOptions(repoPath: string): LocalAgentOptions {
  const local: LocalAgentOptions = {
    cwd: repoPath,
    settingSources: [],
  };
  if (process.platform !== "win32") {
    local.sandboxOptions = { enabled: true };
  }
  return local;
}

/**
 * Host one-shot extract: transcript → Grill session markdown via Cursor SDK.
 * Not a runs row; not AcpBridge / ExecutionEngine.
 */
export const extractGrillSession: ExtractGrillSession = async (input) => {
  const apiKey = (input.apiKey ?? process.env.CURSOR_API_KEY)?.trim();
  if (!apiKey) {
    throw new GrillSessionExtractError("CURSOR_API_KEY is not set");
  }

  const transcriptText = serializeTranscriptForExtract(input.transcript);
  if (!transcriptText.trim()) {
    throw new GrillSessionExtractError("transcript is empty");
  }

  const prompt = buildGrillSessionPrompt(transcriptText, input.promptsRoot);
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: MODEL },
    local: localOptions(input.repoPath),
  });

  if (result.status === "error") {
    throw new GrillSessionExtractError("grill-session extract agent failed");
  }
  if (result.status === "cancelled") {
    throw new GrillSessionExtractError("grill-session extract was cancelled");
  }

  const raw =
    typeof result.result === "string"
      ? result.result
      : result.result != null
        ? String(result.result)
        : "";
  const body = normalizeGrillSessionBody(raw);
  if (!body) {
    throw new GrillSessionExtractError(
      "grill-session extract returned empty or unusable markdown",
    );
  }
  return body;
};
