import fs from "node:fs";
import path from "node:path";
import { renderPrompt } from "../execution/render-prompt.js";

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
  return renderPrompt(
    template,
    {
      cardTitle: input.cardTitle.trim() || "(untitled)",
      cardDescription: input.cardDescription.trim() || "(none)",
      grillSession: input.grillSession.trim() || "(empty)",
      exchangePath: input.exchangePath,
    },
    { promptsRoot },
  );
}
