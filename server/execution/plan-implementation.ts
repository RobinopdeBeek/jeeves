import fs from "node:fs";
import {
  formatCardAttachments,
  nonemptyOr,
  renderPrompt,
  type CardAttachmentInput,
} from "./render-prompt.js";

export type PlanAttachmentInput = CardAttachmentInput;

export interface PlanImplementationPromptInput {
  cardTitle: string;
  cardDescription: string;
  /** Parent feature spec body when this is a child task; empty otherwise. */
  parentSpec: string;
  /** Absolute path to the card's regenerable manifest.json. */
  manifestPath: string;
  attachments: readonly PlanAttachmentInput[];
}

/** @deprecated Prefer formatCardAttachments from render-prompt. */
export const formatPlanAttachments = formatCardAttachments;

/** Vars for the plan-implementation template. */
export function planPromptVars(
  input: PlanImplementationPromptInput,
): Record<string, string> {
  return {
    cardTitle: nonemptyOr(input.cardTitle, "(untitled)"),
    cardDescription: nonemptyOr(input.cardDescription, "(none)"),
    parentSpec: nonemptyOr(input.parentSpec, "(none)"),
    manifestPath: input.manifestPath,
    attachments: formatCardAttachments(input.attachments),
  };
}

/** Load the plan-implementation template and inject Plan inputs. */
export function buildPlanImplementationPrompt(
  input: PlanImplementationPromptInput,
  templatePath: string,
): string {
  return renderPrompt(fs.readFileSync(templatePath, "utf8"), planPromptVars(input));
}
