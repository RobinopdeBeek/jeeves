/** Shared prompt template injection for execution steps. */

export interface CardAttachmentInput {
  absolutePath: string;
  filename: string;
  instruction: string;
}

/** Replace `{{key}}` placeholders; unknown keys are left as-is. */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/** Card Info library block: absolute paths + instructions. */
export function formatCardAttachments(
  attachments: readonly CardAttachmentInput[],
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

export function nonemptyOr(value: string, fallback: string): string {
  return value.trim() || fallback;
}
