import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AcpProcess, SpawnAcp } from "./chat.js";

export class AcpSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpSpawnError";
  }
}

interface AgentLaunch {
  command: string;
  args: string[];
  /** Windows `.cmd` shims need a shell; bare `spawn` cannot run them. */
  shell: boolean;
}

interface AgentResolutionOptions {
  pathEnv?: string;
  wellKnownPaths?: string[];
}

/**
 * Resolve the Cursor Agent CLI. Order: `JEEVES_AGENT_BIN`, PATH (`agent` /
 * `cursor-agent`), then well-known install dirs.
 */
export function resolveAgentLaunch(options: AgentResolutionOptions = {}): AgentLaunch {
  const override = process.env.JEEVES_AGENT_BIN?.trim();
  if (override) {
    return launchFromPath(override);
  }

  for (const name of ["agent", "cursor-agent"]) {
    const fromPath = whichOnPath(name, options.pathEnv);
    if (fromPath) return launchFromPath(fromPath);
  }

  for (const candidate of options.wellKnownPaths ?? wellKnownAgentPaths()) {
    if (fs.existsSync(candidate)) return launchFromPath(candidate);
  }

  throw new AcpSpawnError(
    "Cursor Agent CLI ('agent') not found. Install it from https://cursor.com/install " +
      "(adds %LOCALAPPDATA%\\cursor-agent on Windows), open a new terminal, run `agent login`, " +
      "or set JEEVES_AGENT_BIN to the agent executable.",
  );
}

/** Real `agent acp` subprocess over newline-delimited JSON-RPC stdio. */
export async function createAcpProcess(cwd: string): Promise<AcpProcess> {
  const launch = resolveAgentLaunch();
  const child = spawn(launch.command, [...launch.args, "acp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    shell: launch.shell,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  await waitForSpawn(child);

  const lineHandlers: Array<(line: string) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const handler of lineHandlers) handler(line);
  });

  // Keep stderr from becoming an unhandled crash path; surface later if needed.
  child.stderr.on("data", () => {});
  child.on("error", (err) => {
    for (const handler of errorHandlers) handler(err);
  });

  return {
    write(line: string) {
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    onLine(handler) {
      lineHandlers.push(handler);
    },
    kill() {
      rl.close();
      child.kill();
    },
  };
}

export const spawnAcp: SpawnAcp = (cwd) => createAcpProcess(cwd);

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "ENOENT") {
        reject(
          new AcpSpawnError(
            "Cursor Agent CLI ('agent') not found on PATH. Install from https://cursor.com/install " +
              "or set JEEVES_AGENT_BIN.",
          ),
        );
        return;
      }
      reject(new AcpSpawnError(err.message));
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function launchFromPath(bin: string): AgentLaunch {
  const ext = path.extname(bin).toLowerCase();
  const shell = process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
  return { command: bin, args: [], shell };
}

function wellKnownAgentPaths(): string[] {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  if (process.platform === "win32") {
    return [
      path.join(localAppData, "cursor-agent", "agent.exe"),
      path.join(localAppData, "cursor-agent", "agent.cmd"),
      path.join(localAppData, "cursor-agent", "cursor-agent.exe"),
      path.join(localAppData, "cursor-agent", "cursor-agent.cmd"),
    ];
  }
  return [
    path.join(home, ".local", "bin", "agent"),
    path.join(home, ".local", "bin", "cursor-agent"),
    "/usr/local/bin/agent",
    "/opt/homebrew/bin/agent",
  ];
}

/** Minimal PATH lookup without shelling out (works when PATH is set for the server). */
function whichOnPath(name: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      const alt = path.join(dir, name + ext);
      for (const file of [candidate, alt, path.join(dir, name)]) {
        try {
          if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
        } catch {
          // ignore
        }
      }
    }
  }
  return undefined;
}
