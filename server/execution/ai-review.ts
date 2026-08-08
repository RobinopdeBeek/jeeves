import fs from "node:fs";
import {
  formatPlanAttachments,
  type PlanAttachmentInput,
} from "./plan-implementation.js";

export type AiReviewAttachmentInput = PlanAttachmentInput;

export interface AiReviewPromptInput {
  cardTitle: string;
  cardDescription: string;
  /** Harvested plan artifact body; empty when missing. */
  plan: string;
  /** Absolute path to the card's regenerable manifest.json. */
  manifestPath: string;
  attachments: readonly AiReviewAttachmentInput[];
}

/** Same Card-attachment formatting rules as Plan/Implement. */
export const formatAiReviewAttachments = formatPlanAttachments;

/** Load the ai-review template and inject AI Review inputs. */
export function buildAiReviewPrompt(
  input: AiReviewPromptInput,
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
      formatAiReviewAttachments(input.attachments),
    );
}
