import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** File change status in a three-dot `upstream...cardBranch` range. */
export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange";

export type DiffFileEntry = {
  path: string;
  /** Present when status is renamed or copied. */
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
};

/** Live three-dot summary for the Implement tab DiffViewer. */
export type CardDiffSummary = {
  upstreamRef: string;
  cardBranch: string;
  /** Merge-base of `upstreamRef` and `cardBranch` (three-dot base). */
  baseSha: string;
  /** Tip of `cardBranch`. */
  tipSha: string;
  files: DiffFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
};

/** Seam: list + lazy per-file patch for `upstream...cardBranch` against the host repo. */
export interface CardDiff {
  listThreeDot(upstreamRef: string, cardBranch: string): Promise<CardDiffSummary>;
  filePatch(upstreamRef: string, cardBranch: string, filePath: string): Promise<string>;
}

/**
 * Host-repo three-dot diffs for card branches (no worktree required).
 * Range is always live at view time so AI Review rework appears later.
 */
export class CardDiffService implements CardDiff {
  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
  }

  async listThreeDot(
    upstreamRef: string,
    cardBranch: string,
  ): Promise<CardDiffSummary> {
    const range = `${upstreamRef}...${cardBranch}`;
    const [baseSha, tipSha, nameStatus, numstat] = await Promise.all([
      git(this.repoPath, ["merge-base", upstreamRef, cardBranch]),
      git(this.repoPath, ["rev-parse", cardBranch]),
      git(this.repoPath, ["diff", "--name-status", "--find-renames", range]),
      git(this.repoPath, ["diff", "--numstat", "--find-renames", range]),
    ]);

    const statsByPath = parseNumstat(numstat);
    const files = parseNameStatus(nameStatus).map((entry) => {
      const key = entry.path;
      const stats = statsByPath.get(key) ??
        (entry.oldPath ? statsByPath.get(entry.oldPath) : undefined) ?? {
          additions: 0,
          deletions: 0,
        };
      return {
        ...entry,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    });

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const f of files) {
      totalAdditions += f.additions;
      totalDeletions += f.deletions;
    }

    return {
      upstreamRef,
      cardBranch,
      baseSha: baseSha.trim(),
      tipSha: tipSha.trim(),
      files,
      totalAdditions,
      totalDeletions,
    };
  }

  async filePatch(
    upstreamRef: string,
    cardBranch: string,
    filePath: string,
  ): Promise<string> {
    const normalized = filePath.replace(/\\/g, "/");
    if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized)) {
      throw new CardDiffError(400, "invalid path");
    }
    if (normalized.split("/").includes("..")) {
      throw new CardDiffError(400, "invalid path");
    }
    const range = `${upstreamRef}...${cardBranch}`;
    // Path after `--` is the path on the tip side (and old side for deletes).
    return git(this.repoPath, ["diff", "--find-renames", range, "--", normalized]);
  }
}

export class CardDiffError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CardDiffError";
  }
}

type StatusOnly = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
};

function parseNameStatus(stdout: string): StatusOnly[] {
  const lines = stdout.trimEnd().split("\n").filter(Boolean);
  const out: StatusOnly[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const status = statusFromCode(code);
    if (status === "renamed" || status === "copied") {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (!oldPath || !newPath) continue;
      out.push({ path: newPath, oldPath, status });
    } else {
      const filePath = parts[1];
      if (!filePath) continue;
      out.push({ path: filePath, status });
    }
  }
  return out;
}

function statusFromCode(code: string): DiffFileStatus {
  const letter = code[0];
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
}

function parseNumstat(
  stdout: string,
): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  const lines = stdout.trimEnd().split("\n").filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : Number(parts[0]);
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]);
    // Renames: "old => new" in a single field, or separate fields depending on -z.
    // Without -z, rename paths are "oldPath\tnewPath" making parts length 4,
    // OR a single "old => new" in parts[2] when similarity is shown differently.
    let pathKey: string;
    if (parts.length >= 4) {
      pathKey = parts[3]!;
    } else {
      const pathField = parts[2]!;
      const arrow = pathField.indexOf(" => ");
      pathKey = arrow >= 0 ? pathField.slice(arrow + 4) : pathField;
    }
    map.set(pathKey, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return map;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}
