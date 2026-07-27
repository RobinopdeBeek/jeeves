import fs from "node:fs";
import path from "node:path";

export interface ToSpecPromptInput {
  grillSession: string;
  cardTitle: string;
  cardDescription: string;
  /** Relative to `<repo>/.jeeves/` — e.g. `exchange/<cardId>/spec.md`. */
  exchangePath: string;
}

/** Load prompts/chat/to-spec.md and inject grill session + card + exchange path. */
export function buildToSpecPrompt(
  input: ToSpecPromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "to-spec.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{cardTitle}}", input.cardTitle.trim() || "(untitled)")
    .replaceAll(
      "{{cardDescription}}",
      input.cardDescription.trim() || "(none)",
    )
    .replaceAll("{{grillSession}}", input.grillSession.trim() || "(empty)")
    .replaceAll("{{exchangePath}}", input.exchangePath);
}
