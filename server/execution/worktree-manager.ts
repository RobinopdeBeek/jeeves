import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BRANCH_PREFIX = "jeeves/card-";

export type WorktreeDiagnostics = {
  status: string;
  diff: string;
  diffCached: string;
  headSha: string;
};

/** Seam for ExecutionEngine — WorktreeManager is the production impl. */
export interface WorktreeLifecycle {
  worktreePathFor(cardId: string): string;
  create(cardBranch: string, baseSha: string, worktreePath: string): Promise<void>;
  remove(worktreePath: string): Promise<void>;
  captureDiagnostics(cwd: string): Promise<WorktreeDiagnostics>;
  cleanupOrphans(): Promise<void>;
  resolveRef(ref: string): Promise<string>;
}

export interface WorktreeManagerOptions {
  /** Host path of the target git repository. */
  repoPath: string;
  /** Root for ephemeral worktrees; defaults via `resolveWorktreeRoot`. */
  worktreeRoot?: string;
}

/** Default `<repo>/.jeeves/worktrees/`, or `JEEVES_WORKTREE_ROOT` when set (ADR 0011). */
export function resolveWorktreeRoot(repoPath?: string): string {
  const fromEnv = process.env.JEEVES_WORKTREE_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const root = path.resolve(repoPath ?? process.cwd());
  return path.join(root, ".jeeves", "worktrees");
}

/**
 * Owns ephemeral git worktrees for agent runs (ADR 0009, ADR 0011). Durable
 * branches (`jeeves/card-<id>`) live in the target repo; each run gets a
 * fresh checkout under the configured worktree root.
 */
export class WorktreeManager implements WorktreeLifecycle {
  readonly repoPath: string;
  readonly worktreeRoot: string;

  constructor(options: WorktreeManagerOptions) {
    this.repoPath = path.resolve(options.repoPath);
    this.worktreeRoot = path.resolve(
      options.worktreeRoot ?? resolveWorktreeRoot(options.repoPath),
    );
  }

  /** Durable per-card branch name — never per-step. */
  static cardBranch(cardId: string): string {
    return `${BRANCH_PREFIX}${cardId}`;
  }

  /** Labeled worktree path for a card under the managed root. */
  worktreePathFor(cardId: string): string {
    return path.join(this.worktreeRoot, cardId);
  }

  /** Resolve a local ref to a full SHA without fetching. */
  async resolveRef(ref: string): Promise<string> {
    return (await git(this.repoPath, ["rev-parse", ref])).trim();
  }

  /**
   * Create (or reset) a branch at `baseSha` and check it out at
   * `worktreePath`. Never touches the host's primary checkout.
   */
  async create(
    cardBranch: string,
    baseSha: string,
    worktreePath: string,
  ): Promise<void> {
    const absPath = path.resolve(worktreePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (fs.existsSync(absPath)) {
      await this.remove(absPath);
    }
    await git(this.repoPath, [
      "worktree",
      "add",
      "-B",
      cardBranch,
      absPath,
      baseSha,
    ]);
  }

  /** Remove a worktree directory and unregister it from git. */
  async remove(worktreePath: string): Promise<void> {
    const absPath = path.resolve(worktreePath);
    if (await gitOk(this.repoPath, ["worktree", "remove", "--force", absPath])) {
      return;
    }
    if (fs.existsSync(absPath)) {
      fs.rmSync(absPath, { recursive: true, force: true });
    }
  }

  /** Snapshot porcelain status and diffs before cleanup or retry. */
  async captureDiagnostics(cwd: string): Promise<WorktreeDiagnostics> {
    const [status, diff, diffCached, headSha] = await Promise.all([
      git(cwd, ["status", "--porcelain"]),
      git(cwd, ["diff"]),
      git(cwd, ["diff", "--cached"]),
      git(cwd, ["rev-parse", "HEAD"]),
    ]);
    return {
      status: status.trimEnd(),
      diff: diff.trimEnd(),
      diffCached: diffCached.trimEnd(),
      headSha: headSha.trim(),
    };
  }

  /**
   * Boot-time cleanup of labeled orphan worktrees: any checkout registered
   * under `worktreeRoot`, plus stray directories left on disk.
   */
  async cleanupOrphans(): Promise<void> {
    const labeledRoot = this.worktreeRoot + path.sep;
    const listed = await listWorktreePaths(this.repoPath);

    for (const wtPath of listed) {
      const resolved = path.resolve(wtPath);
      if (resolved === this.repoPath) continue;
      if (resolved.startsWith(labeledRoot) || resolved === this.worktreeRoot) {
        await this.remove(resolved);
      }
    }

    if (!fs.existsSync(this.worktreeRoot)) return;
    for (const entry of fs.readdirSync(this.worktreeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.worktreeRoot, entry.name);
      if (!listed.has(path.resolve(dir))) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function listWorktreePaths(repoPath: string): Promise<Set<string>> {
  const stdout = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(path.resolve(line.slice("worktree ".length)));
    }
  }
  return paths;
}
