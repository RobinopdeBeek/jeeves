import fs from "node:fs";
import path from "node:path";
import { renderPrompt } from "../execution/render-prompt.js";

export interface TasksAssistPromptInput {
  title: string;
  description: string;
  /** Absolute or repo-relative path to CONTEXT.md in the target project. */
  contextPath: string;
  /** Spec markdown body (or empty placeholder). */
  spec: string;
  /** Relative to `<repo>/.jeeves/` — e.g. `exchange/<cardId>/tasks-draft.json`. */
  exchangePath: string;
}

/** Load the tasks-assist opener and fill Spec / exchange placeholders. */
export function buildTasksAssistOpeningPrompt(
  input: TasksAssistPromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "tasks-assist.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return renderPrompt(
    template,
    {
      title: input.title || "(untitled)",
      description: input.description || "(none)",
      contextPath: input.contextPath,
      spec: input.spec.trim() || "(no Spec artifact yet)",
      exchangePath: input.exchangePath,
    },
    { promptsRoot },
  );
}
