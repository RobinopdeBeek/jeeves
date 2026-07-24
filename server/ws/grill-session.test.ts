import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildGrillSessionPrompt,
  normalizeGrillSessionBody,
  serializeTranscriptForExtract,
} from "./grill-session.js";

const promptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prompts",
);

describe("serializeTranscriptForExtract", () => {
  it("role-tags text parts and notes permission parts without dumping them", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Loading skills…" },
          {
            type: "data-permission",
            id: "0",
            data: {
              requestId: "0",
              toolCallId: "call-1",
              title: "ls",
              options: [],
              status: "resolved",
              selectedOptionId: "allow-always",
            },
          },
          { type: "text", text: "**Q1:** What is the scope?" },
        ],
      },
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "A" }],
      },
    ];

    const text = serializeTranscriptForExtract(messages);
    expect(text).toContain("Assistant:");
    expect(text).toContain("**Q1:** What is the scope?");
    expect(text).toContain("[permission request omitted]");
    expect(text).not.toContain("allow-always");
    expect(text).toContain("User:");
    expect(text).toContain("A");
    expect(text).toContain("---");
  });

  it("skips messages with no usable parts", () => {
    const messages: UIMessage[] = [
      { id: "empty", role: "assistant", parts: [{ type: "text", text: "  " }] },
      {
        id: "ok",
        role: "user",
        parts: [{ type: "text", text: "Yes" }],
      },
    ];
    expect(serializeTranscriptForExtract(messages)).toBe("User:\nYes");
  });
});

describe("buildGrillSessionPrompt", () => {
  it("injects the transcript into the grill-session template", () => {
    const prompt = buildGrillSessionPrompt("User:\nHello", promptsRoot);
    expect(prompt).toContain("**Extract** the grilling transcript");
    expect(prompt).toContain("User:\nHello");
    expect(prompt).not.toContain("{{transcript}}");
  });
});

describe("normalizeGrillSessionBody", () => {
  it("accepts a Q&A markdown body", () => {
    const body = normalizeGrillSessionBody(`
# Grill: Tooltips

## Q1: What should a tooltip explain?
**A:** Expiry on each row.
`);
    expect(body).toContain("## Q1:");
    expect(body).toContain("**A:** Expiry on each row.");
  });

  it("strips accidental YAML frontmatter", () => {
    const body = normalizeGrillSessionBody(`---
kind: grill
---

## Q1: Scope?
**A:** Add item only.
`);
    expect(body).toBe("## Q1: Scope?\n**A:** Add item only.");
    expect(body).not.toContain("kind: grill");
  });

  it("rejects empty and non-Q&A chatter", () => {
    expect(normalizeGrillSessionBody("")).toBeNull();
    expect(normalizeGrillSessionBody("   ")).toBeNull();
    expect(normalizeGrillSessionBody("I'll start by loading skills.")).toBeNull();
  });
});
