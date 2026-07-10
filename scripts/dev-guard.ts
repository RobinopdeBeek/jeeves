import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "sandcastle:jeeves";

async function dockerRunning(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

async function imageExists(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", IMAGE]);
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

async function buildImage(): Promise<void> {
  console.log(
    `Building ${IMAGE} (first time, or after Dockerfile changes — may take several minutes)…`,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "sandcastle",
        "docker",
        "build-image",
        "--image-name",
        IMAGE,
        "--dockerfile",
        ".sandcastle/Dockerfile",
      ],
      { cwd: rootDir, stdio: "inherit", shell: process.platform === "win32" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`sandcastle docker build-image exited ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  if (process.env.JEEVES_SKIP_DEV_GUARD) {
    console.log("Skipping dev guard (JEEVES_SKIP_DEV_GUARD is set).");
    return;
  }

  warnIfMissingCursorKey();

  if (!(await dockerRunning())) {
    console.error(
      [
        "Docker is not running.",
        "  Start Docker Desktop, then run npm run dev again.",
        '  Tip: enable "Start Docker Desktop when you sign in" so reboots are painless.',
      ].join("\n"),
    );
    process.exit(1);
  }

  if (!(await imageExists())) {
    await buildImage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
