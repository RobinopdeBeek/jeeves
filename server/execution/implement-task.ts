import fs from "node:fs";
import {
  formatCardAttachments,
  nonemptyOr,
  promptsRootFromTemplatePath,
  renderPrompt,
  type CardAttachmentInput,
} from "./render-prompt.js";

export type ImplementAttachmentInput = CardAttachmentInput;

export interface ImplementTaskPromptInput {
  cardTitle: string;
  cardDescription: string;
  /** Harvested plan artifact body; empty when missing. */
  plan: string;
  /** Absolute path to the card's regenerable manifest.json. */
  manifestPath: string;
  attachments: readonly ImplementAttachmentInput[];
}

/** @deprecated Prefer formatCardAttachments from render-prompt. */
export const formatImplementAttachments = formatCardAttachments;

/** Vars for the implement-task template. */
export function implementPromptVars(
  input: ImplementTaskPromptInput,
): Record<string, string> {
  return {
    cardTitle: nonemptyOr(input.cardTitle, "(untitled)"),
    cardDescription: nonemptyOr(input.cardDescription, "(none)"),
    plan: nonemptyOr(input.plan, "(none)"),
    manifestPath: input.manifestPath,
    attachments: formatCardAttachments(input.attachments),
  };
}

/** Load the implement-task template and inject Implement inputs. */
export function buildImplementTaskPrompt(
  input: ImplementTaskPromptInput,
  templatePath: string,
): string {
  return renderPrompt(
    fs.readFileSync(templatePath, "utf8"),
    implementPromptVars(input),
    { promptsRoot: promptsRootFromTemplatePath(templatePath) },
  );
}
