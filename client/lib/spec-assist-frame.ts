/**
 * Frame a Spec side-chat user turn with the live editor draft.
 * Revision context = side-chat transcript + current spec + user message
 * (not the Grill transcript).
 */
export function frameSpecAssistUserMessage(
  userText: string,
  currentSpecMarkdown: string,
): string {
  return [
    userText.trim(),
    "",
    "---",
    "## Current Spec markdown (from editor)",
    "",
    currentSpecMarkdown,
  ].join("\n");
}
