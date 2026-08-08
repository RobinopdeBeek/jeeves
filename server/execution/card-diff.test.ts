import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardDiffService } from "./card-diff.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

describe("CardDiffService", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-card-diff-"));
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "initial\n");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src/app.ts"), "const x = 1;\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function service() {
    return new CardDiffService(repoPath);
  }

  it("lists three-dot changed files with stats against upstream", async () => {
    const upstreamSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await git(repoPath, ["checkout", "-b", "jeeves/card-task1"]);
    fs.writeFileSync(path.join(repoPath, "src/app.ts"), "const x = 2;\n");
    fs.writeFileSync(path.join(repoPath, "src/new.ts"), "export const y = 3;\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "implement"]);
    const tipSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

    const summary = await service().listThreeDot("main", "jeeves/card-task1");

    expect(summary.upstreamRef).toBe("main");
    expect(summary.cardBranch).toBe("jeeves/card-task1");
    expect(summary.baseSha).toBe(upstreamSha);
    expect(summary.tipSha).toBe(tipSha);
    expect(summary.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        }),
        expect.objectContaining({
          path: "src/new.ts",
          status: "added",
          additions: 1,
          deletions: 0,
        }),
      ]),
    );
    expect(summary.totalAdditions).toBe(2);
    expect(summary.totalDeletions).toBe(1);
  });

  it("includes later tip commits so AI Review rework appears in the live range", async () => {
    await git(repoPath, ["checkout", "-b", "jeeves/card-task2"]);
    fs.writeFileSync(path.join(repoPath, "src/app.ts"), "const x = 2;\n");
    await git(repoPath, ["add", "src/app.ts"]);
    await git(repoPath, ["commit", "-m", "implement"]);
    fs.writeFileSync(path.join(repoPath, "src/app.ts"), "const x = 3;\n");
    fs.writeFileSync(path.join(repoPath, "src/fix.ts"), "export {};\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "ai-review rework"]);
    const tipSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

    const summary = await service().listThreeDot("main", "jeeves/card-task2");

    expect(summary.tipSha).toBe(tipSha);
    expect(summary.files.map((f) => f.path).sort()).toEqual([
      "src/app.ts",
      "src/fix.ts",
    ]);
  });

  it("returns a unified patch for one path lazily", async () => {
    await git(repoPath, ["checkout", "-b", "jeeves/card-task3"]);
    fs.writeFileSync(path.join(repoPath, "src/app.ts"), "const x = 9;\n");
    await git(repoPath, ["add", "src/app.ts"]);
    await git(repoPath, ["commit", "-m", "change app"]);

    const patch = await service().filePatch("main", "jeeves/card-task3", "src/app.ts");

    expect(patch).toContain("diff --git");
    expect(patch).toContain("src/app.ts");
    expect(patch).toContain("-const x = 1;");
    expect(patch).toContain("+const x = 9;");
  });

  it("reports deleted files in the three-dot list", async () => {
    await git(repoPath, ["checkout", "-b", "jeeves/card-del"]);
    await git(repoPath, ["rm", "README.md"]);
    await git(repoPath, ["commit", "-m", "remove readme"]);

    const summary = await service().listThreeDot("main", "jeeves/card-del");
    expect(summary.files).toEqual([
      expect.objectContaining({
        path: "README.md",
        status: "deleted",
        additions: 0,
        deletions: 1,
      }),
    ]);
  });
});
