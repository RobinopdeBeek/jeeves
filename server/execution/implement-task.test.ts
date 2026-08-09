import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildImplementTaskPrompt,
  formatImplementAttachments,
} from "./implement-task.js";

const templatePath = path.resolve(
  import.meta.dirname,
  "../../prompts/execution/implement-task.md",
);

describe("buildImplementTaskPrompt", () => {
  it("injects plan, card fields, manifest path, and card-library attachments", () => {
    const prompt = buildImplementTaskPrompt(
      {
        cardTitle: "Rest timer",
        cardDescription: "Persist countdown across reloads.",
        plan: "# Plan\n\nTouch `timer.ts`; test at CardStore seam.\n",
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

    expect(prompt).toContain("Implement task");
    expect(prompt).toContain("Rest timer");
    expect(prompt).toContain("Persist countdown across reloads.");
    expect(prompt).toContain("Touch `timer.ts`; test at CardStore seam.");
    expect(prompt).toContain("/repo/.jeeves/data/cards/c1/manifest.json");
    expect(prompt).toContain("/repo/.jeeves/data/cards/c1/attachments/a1-mock.png");
    expect(prompt).toContain("Use this layout");
    expect(prompt).toContain("/repo/.jeeves/data/cards/c1/attachments/a2-notes.md");
    expect(prompt).toContain("/tdd");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("slice-3-tracer");
    // Injected attachment entries use absolute paths, not chat pointers.
    expect(prompt).toMatch(/path: `\/repo\/\.jeeves\/data\/cards\/c1\/attachments\//);
  });

  it("treats empty attachment library and missing plan as placeholders", () => {
    const prompt = buildImplementTaskPrompt(
      {
        cardTitle: "Standalone",
        cardDescription: "",
        plan: "",
        manifestPath: "/m/manifest.json",
        attachments: [],
      },
      templatePath,
    );

    expect(prompt).toContain("Standalone");
    expect(prompt).toMatch(/Card attachments[\s\S]*\(none\)/);
    expect(prompt).toMatch(/## Plan[\s\S]*\(none\)/);
  });
});

describe("formatImplementAttachments", () => {
  it("lists absolute paths and instructions without chat pointers", () => {
    const block = formatImplementAttachments([
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
    expect(formatImplementAttachments([])).toBe("(none)");
  });
});
