import fs from "node:fs";
import path from "node:path";

export interface GrillPromptInput {
  title: string;
  description: string;
  /** Absolute or repo-relative path to CONTEXT.md in the target project. */
  contextPath: string;
}

/** Load the grill-with-docs opener and fill card / CONTEXT.md placeholders. */
export function buildGrillOpeningPrompt(
  input: GrillPromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "grill-with-docs.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{title}}", input.title || "(untitled)")
    .replaceAll("{{description}}", input.description || "(none)")
    .replaceAll("{{contextPath}}", input.contextPath);
}
