import fs from "node:fs";
import path from "node:path";

export interface ToDraftTasksPromptInput {
  spec: string;
  grillSession: string;
  cardTitle: string;
  cardDescription: string;
  /** Relative to `<repo>/.jeeves/` — e.g. `exchange/<cardId>/tasks-draft.json`. */
  exchangePath: string;
}

/** Load prompts/chat/to-draft-tasks.md and inject spec + grill + card + exchange path. */
export function buildToDraftTasksPrompt(
  input: ToDraftTasksPromptInput,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "to-draft-tasks.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{cardTitle}}", input.cardTitle.trim() || "(untitled)")
    .replaceAll(
      "{{cardDescription}}",
      input.cardDescription.trim() || "(none)",
    )
    .replaceAll("{{spec}}", input.spec.trim() || "(empty)")
    .replaceAll("{{grillSession}}", input.grillSession.trim() || "(empty)")
    .replaceAll("{{exchangePath}}", input.exchangePath);
}

/**
 * Follow-up prompt after Zod/JSON validation failed on the exchange file.
 * Asks the agent to rewrite the same path with a valid payload.
 */
export function buildToDraftTasksRetryPrompt(input: {
  exchangePath: string;
  validationError: string;
}): string {
  return [
    "The tasks-draft exchange JSON failed host validation.",
    "",
    `Validation error: ${input.validationError}`,
    "",
    "Rewrite **only** the exchange file at this path (relative to `<repo>/.jeeves/`):",
    "",
    `\`${input.exchangePath}\``,
    "",
    "Use this schema exactly:",
    "",
    "```json",
    "{",
    '  "tasks": [',
    "    {",
    '      "title": "string",',
    '      "description": "markdown",',
    '      "depends_on": [0]',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "- `depends_on` is 0-based indices into the same `tasks` array.",
    "- Titles must be non-empty.",
    "- Do not write under `data/`. Reply briefly after the write.",
  ].join("\n");
}
