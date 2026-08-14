import fs from "node:fs";
import path from "node:path";

/** Shared prompt template injection for execution and chat skill openers. */

export interface CardAttachmentInput {
  absolutePath: string;
  filename: string;
  instruction: string;
}

export interface RenderPromptOptions {
  /**
   * Absolute path to the repo's `prompts/` directory. Required when the
   * template contains `{{jeevesHost}}` so the shared host contract can load.
   */
  promptsRoot?: string;
}

/** Placeholder skill templates use to pull in `prompts/shared/jeeves-host.md`. */
export const JEEVES_HOST_PLACEHOLDER = "{{jeevesHost}}";

/** `prompts/` root when `templatePath` lives under `prompts/<kind>/<file>`. */
export function promptsRootFromTemplatePath(templatePath: string): string {
  return path.resolve(path.dirname(templatePath), "..");
}

/** Load the shared host contract markdown (trimmed, no trailing blank flood). */
export function loadJeevesHost(promptsRoot: string): string {
  const hostPath = path.join(promptsRoot, "shared", "jeeves-host.md");
  return fs.readFileSync(hostPath, "utf8").trimEnd();
}

/**
 * Expand `{{jeevesHost}}` from `prompts/shared/jeeves-host.md`, then replace
 * `{{key}}` placeholders. Unknown keys are left as-is.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
  options: RenderPromptOptions = {},
): string {
  let out = template;
  if (out.includes(JEEVES_HOST_PLACEHOLDER)) {
    if (!options.promptsRoot) {
      throw new Error(
        "renderPrompt: template uses {{jeevesHost}} but promptsRoot was not provided",
      );
    }
    out = out.replaceAll(JEEVES_HOST_PLACEHOLDER, loadJeevesHost(options.promptsRoot));
  }
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
