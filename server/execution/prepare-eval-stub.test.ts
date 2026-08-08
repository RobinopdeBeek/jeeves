import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PREPEVAL_STUB_EXCHANGE,
  PREPEVAL_STUB_HTML,
  writePrepareEvalStub,
} from "./prepare-eval-stub.js";

describe("writePrepareEvalStub", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes placeholder eval.html under the worktree .jeeves folder", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-prepeval-"));
    dirs.push(workspacePath);

    await writePrepareEvalStub({
      workspacePath,
      headSha: "abc123",
      baseSha: "abc123",
    });

    const written = fs.readFileSync(
      path.join(workspacePath, PREPEVAL_STUB_EXCHANGE),
      "utf8",
    );
    expect(written).toBe(PREPEVAL_STUB_HTML);
    expect(written).toContain("Prepare Eval stub");
  });
});
