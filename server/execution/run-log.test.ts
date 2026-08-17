import { describe, expect, it } from "vitest";
import { RunLogWriter, formatMessage } from "./run-log.js";

describe("RunLogWriter", () => {
  it("concatenates assistant deltas without newlines", () => {
    const chunks: string[] = [];
    const writer = new RunLogWriter((c) => chunks.push(c));

    writer.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Checking" }] },
    } as never);
    writer.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: " for" }] },
    } as never);
    writer.close();

    expect(chunks.join("")).toBe("Checking for\n");
  });

  it("starts tool lines on their own row", () => {
    const chunks: string[] = [];
    const writer = new RunLogWriter((c) => chunks.push(c));

    writer.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    } as never);
    writer.emit({
      type: "tool_call",
      name: "glob",
      status: "running",
    } as never);

    expect(chunks.join("")).toBe("Done.\n→ glob (running)\n");
  });

  it("formats tool_call lines", () => {
    expect(
      formatMessage({ type: "tool_call", name: "shell", status: "completed" } as never),
    ).toBe("→ shell (completed)");
  });
});

describe("formatMessage lifecycle lines", () => {
  it("names the run, agent and resolved model on system init", () => {
    expect(
      formatMessage({
        type: "system",
        subtype: "init",
        run_id: "run-1",
        agent_id: "agent-1",
        model: { id: "composer-2.5" },
      } as never),
    ).toBe("· system run=run-1 agent=agent-1 model=composer-2.5");
  });

  it("logs each request id so retried attempts are countable", () => {
    expect(
      formatMessage({ type: "request", request_id: "req-2" } as never),
    ).toBe("· request req-2");
  });

  it("logs status with the optional detail message", () => {
    expect(formatMessage({ type: "status", status: "RUNNING" } as never)).toBe(
      "· status RUNNING",
    );
    expect(
      formatMessage({
        type: "status",
        status: "ERROR",
        message: "stream stalled",
      } as never),
    ).toBe("· status ERROR: stream stalled");
  });

  it("logs per-turn usage", () => {
    expect(
      formatMessage({
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      } as never),
    ).toBe("· usage in=10 out=2 total=12");
  });

  it("ignores thinking deltas", () => {
    expect(
      formatMessage({ type: "thinking", text: "hmm" } as never),
    ).toBeUndefined();
  });
});
