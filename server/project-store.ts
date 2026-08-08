import fs from "node:fs";
import path from "node:path";

const STORE_DIR = ".jeeves";
const GITIGNORE_ENTRY = ".jeeves/";

export type ProjectStorePaths = {
  repoPath: string;
  storeRoot: string;
  dbPath: string;
  artifactRoot: string;
  worktreeRoot: string;
  /** AI Chat exchange area: `<repo>/.jeeves/exchange/` */
  exchangeRoot: string;
  /** Project Chat transcripts: `<repo>/.jeeves/data/chat/` */
  chatRoot: string;
};

/** Derive project-store paths from a target repo root (ADR 0011). */
export function resolveProjectStorePaths(repoPath: string): ProjectStorePaths {
  const resolvedRepo = path.resolve(repoPath);
  const storeRoot = path.join(resolvedRepo, STORE_DIR);
  const dbFromEnv = process.env.JEEVES_DB_PATH?.trim();
  const worktreeFromEnv = process.env.JEEVES_WORKTREE_ROOT?.trim();
  const artifactRoot = path.join(storeRoot, "data");

  return {
    repoPath: resolvedRepo,
    storeRoot,
    dbPath: dbFromEnv ? path.resolve(dbFromEnv) : path.join(storeRoot, "jeeves.db"),
    artifactRoot,
    worktreeRoot: worktreeFromEnv
      ? path.resolve(worktreeFromEnv)
      : path.join(storeRoot, "worktrees"),
    exchangeRoot: path.join(storeRoot, "exchange"),
    chatRoot: path.join(artifactRoot, "chat"),
  };
}

/**
 * Relative exchange path under the project-store root for harvest
 * (e.g. `exchange/<cardId>/spec.md` with workspacePath = storeRoot).
 */
export function projectStoreExchangePath(cardId: string, fileName: string): string {
  return path.posix.join("exchange", cardId, fileName);
}

/** Append `.jeeves/` to the target repo's `.gitignore` when not already listed. */
export function ensureGitignoreEntry(repoPath: string): void {
  const gitignorePath = path.join(path.resolve(repoPath), ".gitignore");
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf8")
    : "";

  if (hasGitignoreEntry(existing)) return;

  const suffix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${existing}${suffix}${GITIGNORE_ENTRY}\n`);
}

function hasGitignoreEntry(content: string): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === GITIGNORE_ENTRY || trimmed === STORE_DIR) return true;
  }
  return false;
}

/** Create `<repo>/.jeeves/` layout and ensure `.gitignore` contains `.jeeves/`. */
export function ensureProjectStore(repoPath: string): ProjectStorePaths {
  const paths = resolveProjectStorePaths(repoPath);
  fs.mkdirSync(paths.artifactRoot, { recursive: true });
  fs.mkdirSync(paths.worktreeRoot, { recursive: true });
  fs.mkdirSync(paths.exchangeRoot, { recursive: true });
  fs.mkdirSync(paths.chatRoot, { recursive: true });
  ensureGitignoreEntry(paths.repoPath);
  return paths;
}
