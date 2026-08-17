import type { SDKMessage } from "@cursor/sdk";

/**
 * Lifecycle lines carry the attempt boundaries. `request` gets a fresh
 * `request_id` on every SDK transport / stall auto-retry, and `usage` lands
 * once per turn end — together they tell a single-attempt run apart from a
 * silently retried one.
 */
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
  if (message.type === "system") {
    const model = message.model?.id ?? "(unset)";
    return `· system run=${message.run_id} agent=${message.agent_id} model=${model}`;
  }
  if (message.type === "request") {
    return `· request ${message.request_id}`;
  }
  if (message.type === "status") {
    const detail = message.message ? `: ${message.message}` : "";
    return `· status ${message.status}${detail}`;
  }
  if (message.type === "usage") {
    const { inputTokens, outputTokens, totalTokens } = message.usage;
    return `· usage in=${inputTokens} out=${outputTokens} total=${totalTokens}`;
  }
  if (message.type === "task") {
    const parts = [message.status, message.text].filter(Boolean);
    return `· task ${parts.join(" — ") || "(no detail)"}`;
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
