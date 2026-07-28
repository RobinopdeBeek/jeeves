/**
 * Frame a Tasks side-chat user turn with the live tip JSON for the agent
 * prompt only. The visible chat transcript keeps the bare user text.
 */
export function frameTasksAssistUserMessage(
  userText: string,
  currentTasksDraftJson: string,
): string {
  return [
    userText.trim(),
    "",
    "---",
    "## Current tasks-draft tip JSON (from editor)",
    "",
    currentTasksDraftJson,
  ].join("\n");
}

const TASKS_FRAME_MARKER =
  "\n---\n## Current tasks-draft tip JSON (from editor)\n";

/** Strip a Tasks-assist frame so older transcripts render the user text only. */
export function stripTasksAssistFrame(text: string): string {
  const idx = text.indexOf(TASKS_FRAME_MARKER);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}
