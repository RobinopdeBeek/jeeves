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
