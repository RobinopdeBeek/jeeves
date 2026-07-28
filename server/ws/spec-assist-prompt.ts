import fs from "node:fs";
import path from "node:path";

export interface SpecAssistPromptInput {
  title: string;
  description: string;
  /** Absolute or repo-relative path to CONTEXT.md in the target project. */
  contextPath: string;
  /** Settled Grill session Q&A (ADR 0012), or empty placeholder. */
  grillSession: string;
  /** Relative to `<repo>/.jeeves/` — e.g. `exchange/<cardId>/spec.md`. */
  exchangePath: string;
}

/** Load the spec-assist opener and fill card / Grill session / exchange placeholders. */
export function buildSpecAssistOpeningPrompt(
  input: SpecAssistPromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "spec-assist.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{title}}", input.title || "(untitled)")
    .replaceAll("{{description}}", input.description || "(none)")
    .replaceAll("{{contextPath}}", input.contextPath)
    .replaceAll(
      "{{grillSession}}",
      input.grillSession.trim() || "(no Grill session artifact yet)",
    )
    .replaceAll("{{exchangePath}}", input.exchangePath);
}
