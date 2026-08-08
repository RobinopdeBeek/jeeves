import fs from "node:fs";
import path from "node:path";

export interface PlanAttachmentInput {
  /** Absolute host path to the library file bytes. */
  absolutePath: string;
  filename: string;
  instruction: string;
}

export interface PlanImplementationPromptInput {
  cardTitle: string;
  cardDescription: string;
  /** Parent feature spec body when this is a child task; empty otherwise. */
  parentSpec: string;
  /** Absolute path to the card's regenerable manifest.json. */
  manifestPath: string;
  attachments: readonly PlanAttachmentInput[];
}

/** Render the Card attachments block for the plan prompt. */
export function formatPlanAttachments(
  attachments: readonly PlanAttachmentInput[],
): string {
  if (attachments.length === 0) return "(none)";
  return attachments
    .map((att) => {
      const instruction = att.instruction.trim() || "(none)";
      return [
        `- **${att.filename}**`,
        `  - path: \`${att.absolutePath}\``,
        `  - instruction: ${instruction}`,
      ].join("\n");
    })
    .join("\n");
}

/** Load prompts/execution/plan-implementation.md and inject Plan inputs. */
export function buildPlanImplementationPrompt(
  input: PlanImplementationPromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "execution", "plan-implementation.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{cardTitle}}", input.cardTitle.trim() || "(untitled)")
    .replaceAll(
      "{{cardDescription}}",
      input.cardDescription.trim() || "(none)",
    )
    .replaceAll("{{parentSpec}}", input.parentSpec.trim() || "(none)")
    .replaceAll("{{manifestPath}}", input.manifestPath)
    .replaceAll("{{attachments}}", formatPlanAttachments(input.attachments));
}
