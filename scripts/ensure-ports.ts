import { execFile } from "node:child_process";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

// Load .env so the guard sees the same JEEVES_PORT/JEEVES_CLIENT_PORT overrides
// the server does — otherwise we could free the default ports while the server
// binds a different one from .env.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // No .env — fall back to defaults / shell env.
}

// Fixed dev ports. Keep these in sync with server/index.ts (JEEVES_PORT) and
// vite.config.ts (JEEVES_CLIENT_PORT). Both honour the same env overrides so a
// custom port frees/binds consistently across server, client, and this guard.
const SERVER_PORT = Number(process.env.JEEVES_PORT ?? 3939);
const CLIENT_PORT = Number(process.env.JEEVES_CLIENT_PORT ?? 3940);

const forceKill =
  process.env.JEEVES_KILL_PORTS === "1" || process.argv.includes("--force");

interface PortProcess {
  pid: number;
  name: string;
}

async function findListeners(port: number): Promise<number[]> {
  try {
    if (isWindows) {
      const { stdout: out } = await execFileAsync("netstat", ["-ano", "-p", "tcp"]);
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // Proto  LocalAddress  ForeignAddress  State  PID
        if (parts.length < 5) continue;
        const [, local, , state, pidStr] = parts;
        if (state !== "LISTENING") continue;
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(pidStr);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const { stdout: out } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    return [
      ...new Set(
        out
          .split(/\s+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
  } catch {
    // netstat/lsof exit non-zero when nothing is listening — treat as free.
    return [];
  }
}

async function processName(pid: number): Promise<string> {
  try {
    if (isWindows) {
      const { stdout: out } = await execFileAsync("tasklist", [
        "/FI",
        `PID eq ${pid}`,
        "/FO",
        "CSV",
        "/NH",
      ]);
      return out.match(/^"([^"]+)"/)?.[1] ?? "unknown";
    }
    const { stdout: out } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="]);
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function kill(pid: number): Promise<void> {
  if (isWindows) {
    await execFileAsync("taskkill", ["/PID", String(pid), "/F", "/T"]);
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function confirmKill(port: number, procs: PortProcess[]): Promise<boolean> {
  const list = procs.map((p) => `${p.name} (pid ${p.pid})`).join(", ");
  if (forceKill) {
    console.log(`Port ${port} in use by ${list} — killing (forced).`);
    return true;
  }
  if (!stdin.isTTY) {
    console.log(`Port ${port} in use by ${list} — killing (non-interactive).`);
    return true;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await rl.question(`Port ${port} is in use by ${list}. Kill it? [Y/n] `)
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ensurePort(port: number): Promise<boolean> {
  const pids = await findListeners(port);
  if (pids.length === 0) {
    console.log(`Port ${port} is free.`);
    return true;
  }

  const procs: PortProcess[] = await Promise.all(
    pids.map(async (pid) => ({ pid, name: await processName(pid) })),
  );

  if (!(await confirmKill(port, procs))) {
    console.error(
      `Port ${port} left in use — aborting. Free it manually or set ${
        port === SERVER_PORT ? "JEEVES_PORT" : "JEEVES_CLIENT_PORT"
      } to a different port.`,
    );
    return false;
  }

  for (const proc of procs) {
    try {
      await kill(proc.pid);
      console.log(`Killed ${proc.name} (pid ${proc.pid}) on port ${port}.`);
    } catch (err) {
      console.error(
        `Failed to kill pid ${proc.pid}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  // Give the OS a moment to release the socket before the server binds.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return true;
}

async function main(): Promise<void> {
  const ports = [...new Set([SERVER_PORT, CLIENT_PORT])];
  let ok = true;
  for (const port of ports) {
    if (!(await ensurePort(port))) ok = false;
  }
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
