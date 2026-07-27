/**
 * True when markdown has at least one task-list checkbox under a
 * `## Acceptance criteria` heading (heading match is case-insensitive).
 */
export function hasAcceptanceCriteriaCheckboxes(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let inAcceptance = false;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      inAcceptance =
        heading[1] === "##" &&
        heading[2].trim().toLowerCase() === "acceptance criteria";
      continue;
    }
    if (!inAcceptance) continue;
    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return true;
  }
  return false;
}

/** Spec body is empty for Create Tasks gating (trim whitespace/newlines). */
export function isSpecBodyEmpty(markdown: string): boolean {
  return markdown.trim().length === 0;
}
