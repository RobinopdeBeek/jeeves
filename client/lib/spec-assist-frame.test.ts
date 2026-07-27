import { describe, expect, it } from "vitest";
import { frameSpecAssistUserMessage } from "./spec-assist-frame";

describe("frameSpecAssistUserMessage", () => {
  it("appends current Spec markdown so the agent sees the live draft", () => {
    const framed = frameSpecAssistUserMessage(
      "Add a fridge-only acceptance criterion",
      "# Spec\n\n## Acceptance criteria\n\n- [ ] Track expiry\n",
    );
    expect(framed).toContain("Add a fridge-only acceptance criterion");
    expect(framed).toContain("## Current Spec markdown (from editor)");
    expect(framed).toContain("# Spec");
    expect(framed).toContain("Track expiry");
  });
});
