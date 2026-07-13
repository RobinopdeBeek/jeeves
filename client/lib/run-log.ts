/**
 * Normalize run logs where each assistant token was written on its own line.
 * Tool-call lines (→ …) and blank lines are preserved as row boundaries.
 */
export function formatRunLogText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const rows: string[] = [];
  let paragraph = "";

  const flushParagraph = () => {
    if (paragraph) {
      rows.push(paragraph);
      paragraph = "";
    }
  };

  for (const line of lines) {
    if (line === "") {
      flushParagraph();
      rows.push("");
    } else if (line.startsWith("→ ")) {
      flushParagraph();
      rows.push(line);
    } else {
      paragraph += line;
    }
  }
  flushParagraph();
  return rows.join("\n");
}

/** Append one streamed log event to the live display buffer. */
export function appendLogLine(current: string, line: string): string {
  if (line.startsWith("→ ")) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    return `${current}${prefix}${line}\n`;
  }
  return current + line;
}
