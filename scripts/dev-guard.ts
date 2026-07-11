import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function warnIfMissingCursorKey(): void {
  try {
    process.loadEnvFile(path.join(rootDir, ".env"));
  } catch {
    // No .env — env vars may come from the shell.
  }
  if (!process.env.CURSOR_API_KEY?.trim()) {
    console.warn(
      "Warning: CURSOR_API_KEY is not set in .env — agent runs will fail until you add it.",
    );
  }
}

async function main(): Promise<void> {
  if (process.env.JEEVES_SKIP_DEV_GUARD) {
    console.log("Skipping dev guard (JEEVES_SKIP_DEV_GUARD is set).");
    return;
  }

  warnIfMissingCursorKey();

  if (!(await gitAvailable())) {
    console.error(
      [
        "git is not available on PATH.",
        "  Install Git and ensure `git --version` works, then run npm run dev again.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    "Dev guard OK — agent runs use @cursor/sdk with self-managed git worktrees.",
  );
  console.log("  Regression gate: npm run spike:sdk -- --phase run");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
