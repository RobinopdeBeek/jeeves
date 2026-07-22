import { spawn } from "node:child_process";
import readline from "node:readline";
import type { AcpProcess, SpawnAcp } from "./chat.js";

/** Real `agent acp` subprocess over newline-delimited JSON-RPC stdio. */
export function createAcpProcess(cwd: string): AcpProcess {
  const child = spawn("agent", ["acp"], {
    cwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("agent acp failed to open stdio pipes");
  }

  const lineHandlers: Array<(line: string) => void> = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const handler of lineHandlers) handler(line);
  });

  return {
    write(line: string) {
      child.stdin!.write(line.endsWith("\n") ? line : `${line}\n`);
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
