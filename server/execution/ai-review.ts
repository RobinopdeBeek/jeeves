import fs from "node:fs";
import {
  formatCardAttachments,
  nonemptyOr,
  promptsRootFromTemplatePath,
  renderPrompt,
  type CardAttachmentInput,
} from "./render-prompt.js";

export type AiReviewAttachmentInput = CardAttachmentInput;

export interface AiReviewPromptInput {
  cardTitle: string;
  cardDescription: string;
  /** Harvested plan artifact body; empty when missing. */
  plan: string;
  /** Absolute path to the card's regenerable manifest.json. */
  manifestPath: string;
  attachments: readonly AiReviewAttachmentInput[];
}

/** @deprecated Prefer formatCardAttachments from render-prompt. */
export const formatAiReviewAttachments = formatCardAttachments;

/** Vars for the ai-review template. */
export function aiReviewPromptVars(
  input: AiReviewPromptInput,
): Record<string, string> {
  return {
    cardTitle: nonemptyOr(input.cardTitle, "(untitled)"),
    cardDescription: nonemptyOr(input.cardDescription, "(none)"),
    plan: nonemptyOr(input.plan, "(none)"),
    manifestPath: input.manifestPath,
    attachments: formatCardAttachments(input.attachments),
  };
}

/** Load the ai-review template and inject AI Review inputs. */
export function buildAiReviewPrompt(
  input: AiReviewPromptInput,
  templatePath: string,
): string {
  return renderPrompt(
    fs.readFileSync(templatePath, "utf8"),
    aiReviewPromptVars(input),
    { promptsRoot: promptsRootFromTemplatePath(templatePath) },
  );
}
