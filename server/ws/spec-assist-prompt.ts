import fs from "node:fs";
import path from "node:path";
import { renderPrompt } from "../execution/render-prompt.js";

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
  return renderPrompt(
    template,
    {
      title: input.title || "(untitled)",
      description: input.description || "(none)",
      contextPath: input.contextPath,
      grillSession:
        input.grillSession.trim() || "(no Grill session artifact yet)",
      exchangePath: input.exchangePath,
    },
    { promptsRoot },
  );
}
