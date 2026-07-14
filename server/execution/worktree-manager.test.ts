import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorktreeRoot, WorktreeManager, filterPorcelainStatus } from "./worktree-manager.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

interface TempRepo {
  repoPath: string;
  mainSha: string;
  worktreeRoot: string;
}

/** Git porcelain uses forward slashes even on Windows. */
function gitPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

describe("WorktreeManager", () => {
  let temp: TempRepo;

  beforeEach(async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-wt-repo-"));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-wt-root-"));
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "initial\n");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    const mainSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    temp = { repoPath, mainSha, worktreeRoot };
  });

  afterEach(async () => {
    const manager = new WorktreeManager({
      repoPath: temp.repoPath,
      worktreeRoot: temp.worktreeRoot,
    });
    try {
      await manager.cleanupOrphans();
    } catch {
      // best effort
    }
    fs.rmSync(temp.repoPath, { recursive: true, force: true });
    fs.rmSync(temp.worktreeRoot, { recursive: true, force: true });
  });

  function manager() {
    return new WorktreeManager({
      repoPath: temp.repoPath,
      worktreeRoot: temp.worktreeRoot,
    });
  }

  it("names card branches jeeves/card-<id>", () => {
    expect(WorktreeManager.cardBranch("abc123")).toBe("jeeves/card-abc123");
  });

  it("defaults worktree root to <repo>/.jeeves/worktrees when omitted", () => {
    const repo = "C:/projects/pantry-checker";
    expect(resolveWorktreeRoot(repo)).toBe(
      path.join(path.resolve(repo), ".jeeves", "worktrees"),
    );
  });

  it("creates and removes a worktree at baseSha", async () => {
    const wm = manager();
    const cardId = "card-1";
    const branch = WorktreeManager.cardBranch(cardId);
    const wtPath = wm.worktreePathFor(cardId);

    await wm.create(branch, temp.mainSha, wtPath);

    expect(fs.existsSync(wtPath)).toBe(true);
    const head = (await git(wtPath, ["rev-parse", "HEAD"])).trim();
    expect(head).toBe(temp.mainSha);
    const currentBranch = (await git(wtPath, ["branch", "--show-current"])).trim();
    expect(currentBranch).toBe(branch);

    await wm.remove(wtPath);
    const listed = await git(temp.repoPath, ["worktree", "list", "--porcelain"]);
    expect(listed).not.toContain(gitPath(wtPath));
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("ignores exchange paths in worktreeStatus when requested", async () => {
    const wm = manager();
    const cardId = "card-exchange";
    const wtPath = wm.worktreePathFor(cardId);
    await wm.create(WorktreeManager.cardBranch(cardId), temp.mainSha, wtPath);

    const exchangeDir = path.join(wtPath, ".jeeves");
    fs.mkdirSync(exchangeDir, { recursive: true });
    fs.writeFileSync(path.join(exchangeDir, "plan.md"), "# Plan\n\nDo the thing.\n");

    const raw = await wm.worktreeStatus(wtPath);
    expect(raw).toContain(".jeeves");

    const filtered = await wm.worktreeStatus(wtPath, { ignorePathPrefixes: [".jeeves"] });
    expect(filtered).toBe("");

    await wm.remove(wtPath);
  });

  it("captures diagnostics for dirty and staged changes", async () => {
    const wm = manager();
    const cardId = "card-diag";
    const wtPath = wm.worktreePathFor(cardId);
    await wm.create(WorktreeManager.cardBranch(cardId), temp.mainSha, wtPath);

    fs.writeFileSync(path.join(wtPath, "README.md"), "changed\n");
    fs.writeFileSync(path.join(wtPath, "staged.txt"), "staged\n");
    await git(wtPath, ["add", "staged.txt"]);

    const diag = await wm.captureDiagnostics(wtPath);
    expect(diag.headSha).toBe(temp.mainSha);
    expect(diag.status).toContain("README.md");
    expect(diag.status).toContain("staged.txt");
    expect(diag.diff).toContain("changed");
    expect(diag.diffCached).toContain("staged");

    await wm.remove(wtPath);
  });

  it("keeps worktree writes isolated from the host checkout", async () => {
    const wm = manager();
    const cardId = "card-iso";
    const wtPath = wm.worktreePathFor(cardId);
    await wm.create(WorktreeManager.cardBranch(cardId), temp.mainSha, wtPath);

    const probeName = ".worktree-probe.txt";
    fs.writeFileSync(path.join(wtPath, probeName), "probe");
    const leakedToHost = fs.existsSync(path.join(temp.repoPath, probeName));

    expect(leakedToHost).toBe(false);
    expect(fs.existsSync(path.join(wtPath, probeName))).toBe(true);
    const hostStatus = (await git(temp.repoPath, ["status", "--porcelain"])).trim();
    expect(hostStatus).not.toContain(probeName);

    await wm.remove(wtPath);
  });

  it("cleanupOrphans removes labeled worktrees left from a prior run", async () => {
    const wm = manager();
    const cardId = "orphan-card";
    const wtPath = wm.worktreePathFor(cardId);
    await wm.create(WorktreeManager.cardBranch(cardId), temp.mainSha, wtPath);

    const listedBefore = await git(temp.repoPath, ["worktree", "list", "--porcelain"]);
    expect(listedBefore).toContain(`worktree ${gitPath(wtPath)}`);

    await wm.cleanupOrphans();

    const listedAfter = await git(temp.repoPath, ["worktree", "list", "--porcelain"]);
    expect(listedAfter).not.toContain(gitPath(wtPath));
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("cleanupOrphans removes unregistered directories under the labeled root", async () => {
    const wm = manager();
    const staleDir = path.join(temp.worktreeRoot, "stale-dir");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "leftover.txt"), "orphan");

    await wm.cleanupOrphans();

    expect(fs.existsSync(staleDir)).toBe(false);
  });
});

describe("filterPorcelainStatus", () => {
  it("drops lines under ignored path prefixes", () => {
    const raw = ["?? .jeeves/", "?? .jeeves/plan.md", " M README.md"].join("\n");
    expect(filterPorcelainStatus(raw, [".jeeves"])).toBe(" M README.md");
  });
});
