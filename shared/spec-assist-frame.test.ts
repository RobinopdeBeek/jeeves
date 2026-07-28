import { describe, expect, it } from "vitest";
import {
  frameSpecAssistUserMessage,
  stripSpecAssistFrame,
} from "./spec-assist-frame";

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

describe("stripSpecAssistFrame", () => {
  it("returns bare user text from a framed message", () => {
    const framed = frameSpecAssistUserMessage(
      "Tighten acceptance criteria",
      "# Spec\n\nDraft body\n",
    );
    expect(stripSpecAssistFrame(framed)).toBe("Tighten acceptance criteria");
  });

  it("leaves unframed text unchanged", () => {
    expect(stripSpecAssistFrame("Just a question")).toBe("Just a question");
  });
});
