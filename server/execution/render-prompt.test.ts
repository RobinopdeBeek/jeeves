import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  JEEVES_HOST_PLACEHOLDER,
  loadJeevesHost,
  promptsRootFromTemplatePath,
  renderPrompt,
} from "./render-prompt.js";

const promptsRoot = path.resolve(import.meta.dirname, "../../prompts");

/** Live skill templates that must pull in the shared host contract. */
const SKILL_TEMPLATE_GLOBS = [
  path.join(promptsRoot, "chat", "*.md"),
  path.join(promptsRoot, "execution", "*.md"),
] as const;

function listSkillTemplates(): string[] {
  const files: string[] = [];
  for (const pattern of SKILL_TEMPLATE_GLOBS) {
    const dir = path.dirname(pattern);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      // Historical tracer — not a product skill.
      if (name === "slice-3-tracer.md") continue;
      files.push(path.join(dir, name));
    }
  }
  return files.sort();
}

describe("renderPrompt {{jeevesHost}}", () => {
  it("expands the shared host contract when promptsRoot is set", () => {
    const out = renderPrompt(
      `# Skill\n\n${JEEVES_HOST_PLACEHOLDER}\n\nHi {{name}}.`,
      { name: "Robin" },
      { promptsRoot },
    );
    expect(out).toContain("## Jeeves host rules");
    expect(out).toContain("Hi Robin.");
    expect(out).not.toContain(JEEVES_HOST_PLACEHOLDER);
    expect(out).toMatch(/sibling repos/i);
  });

  it("throws when the template needs jeevesHost but promptsRoot is missing", () => {
    expect(() =>
      renderPrompt(`Before\n${JEEVES_HOST_PLACEHOLDER}\nAfter`, {}),
    ).toThrow(/promptsRoot/);
  });

  it("leaves templates without the placeholder unchanged aside from vars", () => {
    expect(renderPrompt("Hello {{name}}", { name: "x" })).toBe("Hello x");
  });

  it("loads jeeves-host.md from prompts/shared", () => {
    const host = loadJeevesHost(promptsRoot);
    expect(host).toMatch(/^## Jeeves host rules/m);
    expect(host).toMatch(/Do not hunt the project store or SQLite/i);
  });

  it("derives promptsRoot from a skill template path", () => {
    const templatePath = path.join(
      promptsRoot,
      "execution",
      "plan-implementation.md",
    );
    expect(promptsRootFromTemplatePath(templatePath)).toBe(promptsRoot);
  });
});

describe("skill templates include {{jeevesHost}}", () => {
  it("lists every chat and execution skill template", () => {
    const files = listSkillTemplates();
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const body = fs.readFileSync(file, "utf8");
      expect(body, path.relative(promptsRoot, file)).toContain(
        JEEVES_HOST_PLACEHOLDER,
      );
    }
  });
});
