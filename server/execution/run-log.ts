import type { SDKMessage } from "@cursor/sdk";

export function formatMessage(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    return message.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  if (message.type === "tool_call") {
    return `→ ${message.name} (${message.status})`;
  }
  return undefined;
}

/**
 * Tee SDK stream events to a run log without breaking assistant text across
 * lines — only tool calls and paragraph boundaries get newlines.
 */
export class RunLogWriter {
  private assistantPending = false;

  constructor(private readonly write: (chunk: string) => void) {}

  /** Returns the line to yield over SSE, if any. */
  emit(message: SDKMessage): string | undefined {
    const line = formatMessage(message);
    if (line === undefined) return undefined;

    if (message.type === "assistant") {
      this.write(line);
      this.assistantPending = true;
      return line;
    }

    if (this.assistantPending) this.write("\n");
    this.assistantPending = false;
    this.write(`${line}\n`);
    return line;
  }

  close(): void {
    if (this.assistantPending) this.write("\n");
    this.assistantPending = false;
  }
}
