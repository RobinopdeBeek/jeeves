/**
 * Frame a Spec side-chat user turn with the live editor draft for the agent
 * prompt only. The visible chat transcript keeps the bare user text.
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

const SPEC_FRAME_MARKER = "\n---\n## Current Spec markdown (from editor)\n";

/** Strip a Spec-assist frame so older transcripts render the user text only. */
export function stripSpecAssistFrame(text: string): string {
  const idx = text.indexOf(SPEC_FRAME_MARKER);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}
