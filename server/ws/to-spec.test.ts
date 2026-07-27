import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildToSpecPrompt } from "./to-spec.js";

const promptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prompts",
);

describe("buildToSpecPrompt", () => {
  it("injects grill session, card metadata, CONTEXT.md, and exchange path", () => {
    const prompt = buildToSpecPrompt(
      {
        grillSession: "## Q1: Scope?\n**A:** Add item only.",
        cardTitle: "Pantry checker",
        cardDescription: "Track expiry dates.",
        exchangePath: "exchange/card123/spec.md",
      },
      promptsRoot,
    );

    expect(prompt).toContain("## Q1: Scope?");
    expect(prompt).toContain("**A:** Add item only.");
    expect(prompt).toContain("Pantry checker");
    expect(prompt).toContain("Track expiry dates.");
    expect(prompt).toContain("CONTEXT.md");
    expect(prompt).toContain("exchange/card123/spec.md");
    expect(prompt).not.toContain("{{grillSession}}");
    expect(prompt).not.toContain("{{exchangePath}}");
    expect(prompt).toMatch(/do \*\*not\*\* publish to an issue tracker/i);
    expect(prompt).not.toContain("ready-for-agent");
  });
});
