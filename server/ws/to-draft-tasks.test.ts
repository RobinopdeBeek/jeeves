import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildToDraftTasksPrompt,
  buildToDraftTasksRetryPrompt,
} from "./to-draft-tasks.js";

const promptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prompts",
);

describe("buildToDraftTasksPrompt", () => {
  it("injects spec, grill session, card metadata, CONTEXT.md, and exchange path", () => {
    const prompt = buildToDraftTasksPrompt(
      {
        spec: "# Spec\n\n## Problem Statement\nTrack pantry expiry.\n",
        grillSession: "## Q1: Scope?\n**A:** Add item only.",
        cardTitle: "Pantry checker",
        cardDescription: "Track expiry dates.",
        exchangePath: "exchange/card123/tasks-draft.json",
      },
      promptsRoot,
    );

    expect(prompt).toContain("Track pantry expiry");
    expect(prompt).toContain("## Q1: Scope?");
    expect(prompt).toContain("Pantry checker");
    expect(prompt).toContain("Track expiry dates.");
    expect(prompt).toContain("CONTEXT.md");
    expect(prompt).toContain("exchange/card123/tasks-draft.json");
    expect(prompt).toContain("depends_on");
    expect(prompt).not.toContain("{{spec}}");
    expect(prompt).not.toContain("{{exchangePath}}");
    expect(prompt).toMatch(/do \*\*not\*\* publish to an issue tracker/i);
    expect(prompt).toMatch(/vertical.?slice/i);
  });
});

describe("buildToDraftTasksRetryPrompt", () => {
  it("injects the validation error and exchange path", () => {
    const prompt = buildToDraftTasksRetryPrompt({
      exchangePath: "exchange/card123/tasks-draft.json",
      validationError: "title must be non-empty",
    });
    expect(prompt).toContain("title must be non-empty");
    expect(prompt).toContain("exchange/card123/tasks-draft.json");
    expect(prompt).toContain("depends_on");
  });
});
