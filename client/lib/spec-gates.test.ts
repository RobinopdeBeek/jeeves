import { describe, expect, it } from "vitest";
import {
  hasAcceptanceCriteriaCheckboxes,
  isSpecBodyEmpty,
} from "./spec-gates.js";

describe("isSpecBodyEmpty", () => {
  it("treats whitespace-only as empty", () => {
    expect(isSpecBodyEmpty("")).toBe(true);
    expect(isSpecBodyEmpty("  \n\t  ")).toBe(true);
    expect(isSpecBodyEmpty("# Spec")).toBe(false);
  });
});

describe("hasAcceptanceCriteriaCheckboxes", () => {
  it("finds a checkbox under Acceptance criteria (case-insensitive)", () => {
    const md = `# Spec

## Acceptance Criteria

- [ ] User can save
- [x] User can load
`;
    expect(hasAcceptanceCriteriaCheckboxes(md)).toBe(true);
  });

  it("returns false when the section has no checkboxes", () => {
    const md = `# Spec

## Acceptance criteria

Ship it somehow.
`;
    expect(hasAcceptanceCriteriaCheckboxes(md)).toBe(false);
  });

  it("ignores checkboxes outside the Acceptance criteria section", () => {
    const md = `# Spec

- [ ] Not under AC

## Acceptance criteria

Just prose.
`;
    expect(hasAcceptanceCriteriaCheckboxes(md)).toBe(false);
  });

  it("stops at the next heading", () => {
    const md = `## Acceptance criteria

## Other

- [ ] Too late
`;
    expect(hasAcceptanceCriteriaCheckboxes(md)).toBe(false);
  });

  it("ignores Acceptance criteria at heading levels other than ##", () => {
    const md = `# Acceptance criteria

- [ ] Wrong level
`;
    expect(hasAcceptanceCriteriaCheckboxes(md)).toBe(false);
  });
});
