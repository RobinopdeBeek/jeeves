import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HUMAN_REVIEW_REPORT_STUB_EXCHANGE,
  HUMAN_REVIEW_REPORT_STUB_HTML,
  writePrepareHumanReviewStub,
} from "./prepare-human-review-stub.js";

describe("writePrepareHumanReviewStub", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a placeholder Human Review Report under the worktree .jeeves folder", async () => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "jeeves-prepare-human-review-"),
    );
    dirs.push(workspacePath);

    await writePrepareHumanReviewStub({
      workspacePath,
      headSha: "abc123",
      baseSha: "abc123",
    });

    const written = fs.readFileSync(
      path.join(workspacePath, HUMAN_REVIEW_REPORT_STUB_EXCHANGE),
      "utf8",
    );
    expect(written).toBe(HUMAN_REVIEW_REPORT_STUB_HTML);
    expect(written).toContain("Prepare Human Review stub");
  });
});
