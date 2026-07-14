import path from "node:path";
import { fileURLToPath } from "node:url";

// Same port resolution as server/index.ts and vite.config.ts.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // No .env — fall back to defaults / shell env.
}

const port = Number(process.env.JEEVES_PORT ?? 3939);
const url = `http://127.0.0.1:${port}/api/project`;
const timeoutMs = 30_000;
const intervalMs = 100;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      if (!announced) {
        console.log(`Waiting for API server on port ${port}…`);
        announced = true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.error(`Timed out waiting for API server at ${url}`);
  process.exit(1);
}

waitForServer().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
