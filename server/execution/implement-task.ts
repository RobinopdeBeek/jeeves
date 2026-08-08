import fs from "node:fs";
import {
  formatPlanAttachments,
  type PlanAttachmentInput,
} from "./plan-implementation.js";

export type ImplementAttachmentInput = PlanAttachmentInput;

export interface ImplementTaskPromptInput {
  cardTitle: string;
  cardDescription: string;
  /** Harvested plan artifact body; empty when missing. */
  plan: string;
  /** Absolute path to the card's regenerable manifest.json. */
  manifestPath: string;
  attachments: readonly ImplementAttachmentInput[];
}

/** Same Card-attachment formatting rules as Plan (absolute paths + instructions). */
export const formatImplementAttachments = formatPlanAttachments;

/** Load the implement-task template and inject Implement inputs. */
export function buildImplementTaskPrompt(
  input: ImplementTaskPromptInput,
  templatePath: string,
): string {
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{cardTitle}}", input.cardTitle.trim() || "(untitled)")
    .replaceAll(
      "{{cardDescription}}",
      input.cardDescription.trim() || "(none)",
    )
    .replaceAll("{{plan}}", input.plan.trim() || "(none)")
    .replaceAll("{{manifestPath}}", input.manifestPath)
    .replaceAll(
      "{{attachments}}",
      formatImplementAttachments(input.attachments),
    );
}
