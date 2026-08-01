import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTasksAssistOpeningPrompt } from "./tasks-assist-prompt.js";

const promptsRoot = path.resolve(import.meta.dirname, "../../prompts");

describe("buildTasksAssistOpeningPrompt", () => {
  it("injects card, Spec, and exchange path", () => {
    const prompt = buildTasksAssistOpeningPrompt(
      {
        title: "Pantry",
        description: "Track expiry",
        contextPath: "C:/repo/CONTEXT.md",
        spec: "# Spec\n\nFridge only.",
        exchangePath: "exchange/card123/tasks-draft.json",
      },
      promptsRoot,
    );
    expect(prompt).toContain("Pantry");
    expect(prompt).toContain("Track expiry");
    expect(prompt).toContain("Fridge only.");
    expect(prompt).toContain("exchange/card123/tasks-draft.json");
    expect(prompt).toContain("Here for you if you need me.");
    expect(prompt).toContain("Do **not** recap the Spec");
    expect(prompt).toContain("only** source of truth");
    expect(prompt).not.toContain("to-tasks-revise");
  });
});
