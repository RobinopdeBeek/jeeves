import fs from "node:fs";
import path from "node:path";

export interface TasksRevisePromptInput {
  title: string;
  description: string;
  /** Absolute or repo-relative path to CONTEXT.md in the target project. */
  contextPath: string;
  /** Spec markdown body (or empty placeholder). */
  spec: string;
  /** Relative to `<repo>/.jeeves/` — e.g. `exchange/<cardId>/tasks-draft.json`. */
  exchangePath: string;
}

/** Load the to-tasks-revise opener and fill Spec / exchange placeholders. */
export function buildTasksReviseOpeningPrompt(
  input: TasksRevisePromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "to-tasks-revise.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{title}}", input.title || "(untitled)")
    .replaceAll("{{description}}", input.description || "(none)")
    .replaceAll("{{contextPath}}", input.contextPath)
    .replaceAll("{{spec}}", input.spec.trim() || "(no Spec artifact yet)")
    .replaceAll("{{exchangePath}}", input.exchangePath);
}
