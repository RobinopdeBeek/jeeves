import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_DIFF_SOFT_LINE_LIMIT,
  diffNeedsLoadConfirmation,
  shortSha,
  shouldShowImplementDiff,
} from "./implement-diff-view";

describe("implement-diff-view", () => {
  it("shows the DiffViewer only for a successful Implement step", () => {
    expect(shouldShowImplementDiff("impl", "done")).toBe(true);
    expect(shouldShowImplementDiff("impl", "needs-user")).toBe(false);
    expect(shouldShowImplementDiff("impl", "ai-working")).toBe(false);
    expect(shouldShowImplementDiff("plan", "done")).toBe(false);
    expect(shouldShowImplementDiff("airev", "done")).toBe(false);
  });

  it("soft-warns when total changed lines exceed the limit", () => {
    expect(diffNeedsLoadConfirmation(100, 100)).toBe(false);
    expect(
      diffNeedsLoadConfirmation(
        IMPLEMENT_DIFF_SOFT_LINE_LIMIT,
        1,
      ),
    ).toBe(true);
    expect(diffNeedsLoadConfirmation(1500, 1500)).toBe(false);
    expect(diffNeedsLoadConfirmation(1501, 1500)).toBe(true);
  });

  it("shortens SHAs for attribution", () => {
    expect(shortSha("abcdef0123456789")).toBe("abcdef0");
  });
});
