import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureGitignoreEntry,
  ensureProjectStore,
  resolveProjectStorePaths,
} from "./project-store.js";

describe("resolveProjectStorePaths", () => {
  const repoPath = path.join(os.tmpdir(), "my-project");

  afterEach(() => {
    delete process.env.JEEVES_DB_PATH;
    delete process.env.JEEVES_WORKTREE_ROOT;
  });

  it("derives default paths under <repo>/.jeeves/", () => {
    const paths = resolveProjectStorePaths(repoPath);

    expect(paths.repoPath).toBe(path.resolve(repoPath));
    expect(paths.storeRoot).toBe(path.join(path.resolve(repoPath), ".jeeves"));
    expect(paths.dbPath).toBe(path.join(path.resolve(repoPath), ".jeeves", "jeeves.db"));
    expect(paths.artifactRoot).toBe(path.join(path.resolve(repoPath), ".jeeves", "data"));
    expect(paths.worktreeRoot).toBe(
      path.join(path.resolve(repoPath), ".jeeves", "worktrees"),
    );
  });

  it("honours JEEVES_DB_PATH override", () => {
    const customDb = path.join(os.tmpdir(), "custom", "board.db");
    process.env.JEEVES_DB_PATH = customDb;

    const paths = resolveProjectStorePaths(repoPath);

    expect(paths.dbPath).toBe(path.resolve(customDb));
    expect(paths.artifactRoot).toBe(path.join(path.resolve(repoPath), ".jeeves", "data"));
  });

  it("honours JEEVES_WORKTREE_ROOT override", () => {
    const customWt = path.join(os.tmpdir(), "custom-worktrees");
    process.env.JEEVES_WORKTREE_ROOT = customWt;

    const paths = resolveProjectStorePaths(repoPath);

    expect(paths.worktreeRoot).toBe(path.resolve(customWt));
  });
});

describe("ensureGitignoreEntry", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-ps-repo-"));
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("creates .gitignore with .jeeves/ when missing", () => {
    ensureGitignoreEntry(tempRepo);

    const content = fs.readFileSync(path.join(tempRepo, ".gitignore"), "utf8");
    expect(content).toContain(".jeeves/");
  });

  it("appends .jeeves/ to an existing .gitignore", () => {
    const gitignorePath = path.join(tempRepo, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules/\n");

    ensureGitignoreEntry(tempRepo);

    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toBe("node_modules/\n.jeeves/\n");
  });

  it("is idempotent when .jeeves/ is already present", () => {
    const gitignorePath = path.join(tempRepo, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules/\n.jeeves/\n");

    ensureGitignoreEntry(tempRepo);

    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toBe("node_modules/\n.jeeves/\n");
  });

  it("treats commented .jeeves/ lines as absent", () => {
    const gitignorePath = path.join(tempRepo, ".gitignore");
    fs.writeFileSync(gitignorePath, "# .jeeves/\n");

    ensureGitignoreEntry(tempRepo);

    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toBe("# .jeeves/\n.jeeves/\n");
  });
});

describe("ensureProjectStore", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-ps-store-"));
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("creates store directories and returns resolved paths", () => {
    const paths = ensureProjectStore(tempRepo);

    expect(fs.existsSync(paths.storeRoot)).toBe(true);
    expect(fs.existsSync(paths.artifactRoot)).toBe(true);
    expect(fs.existsSync(paths.worktreeRoot)).toBe(true);
    expect(fs.readFileSync(path.join(tempRepo, ".gitignore"), "utf8")).toContain(".jeeves/");
  });
});
