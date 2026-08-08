import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlanImplementationPrompt,
  formatPlanAttachments,
} from "./plan-implementation.js";

const templatePath = path.resolve(
  import.meta.dirname,
  "../../prompts/execution/plan-implementation.md",
);

describe("buildPlanImplementationPrompt", () => {
  it("injects card fields, parent spec, manifest path, and attachments", () => {
    const prompt = buildPlanImplementationPrompt(
      {
        cardTitle: "Rest timer",
        cardDescription: "Persist countdown across reloads.",
        parentSpec: "# Feature spec\n\nTimers must survive refresh.",
        manifestPath: "/repo/.jeeves/data/cards/c1/manifest.json",
        attachments: [
          {
            absolutePath: "/repo/.jeeves/data/cards/c1/attachments/a1-mock.png",
            filename: "mock.png",
            instruction: "Use this layout",
          },
          {
            absolutePath: "/repo/.jeeves/data/cards/c1/attachments/a2-notes.md",
            filename: "notes.md",
            instruction: "",
          },
        ],
      },
      templatePath,
    );

    expect(prompt).toContain("Rest timer");
    expect(prompt).toContain("Persist countdown across reloads.");
    expect(prompt).toContain("Timers must survive refresh.");
    expect(prompt).toContain("/repo/.jeeves/data/cards/c1/manifest.json");
    expect(prompt).toContain("/repo/.jeeves/data/cards/c1/attachments/a1-mock.png");
    expect(prompt).toContain("Use this layout");
    expect(prompt).toContain("/repo/.jeeves/data/cards/c1/attachments/a2-notes.md");
    expect(prompt).toContain(".jeeves/plan.md");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("slice-3-tracer");
    // Injected attachment entries use absolute paths, not chat pointers.
    expect(prompt).toMatch(/path: `\/repo\/\.jeeves\/data\/cards\/c1\/attachments\//);
    // Context7 / MCP missing must not hard-fail Plan (#64).
    expect(prompt).toMatch(/Context7[\s\S]*non-fatal|missing tools are non-fatal/i);
  });

  it("treats empty attachment library like no attachments", () => {
    const prompt = buildPlanImplementationPrompt(
      {
        cardTitle: "Standalone",
        cardDescription: "",
        parentSpec: "",
        manifestPath: "/m/manifest.json",
        attachments: [],
      },
      templatePath,
    );

    expect(prompt).toContain("Standalone");
    expect(prompt).toMatch(/Card attachments[\s\S]*\(none\)/);
    expect(prompt).toMatch(/Parent feature spec[\s\S]*\(none\)/);
  });
});

describe("formatPlanAttachments", () => {
  it("lists absolute paths and instructions without chat pointers", () => {
    const block = formatPlanAttachments([
      {
        absolutePath: "/abs/a1-wire.png",
        filename: "wire.png",
        instruction: "Primary mock",
      },
    ]);
    expect(block).toContain("`/abs/a1-wire.png`");
    expect(block).toContain("wire.png");
    expect(block).toContain("Primary mock");
    expect(block).not.toContain("jeeves-attachment://");
  });

  it("returns (none) for an empty library", () => {
    expect(formatPlanAttachments([])).toBe("(none)");
  });
});
