import { spawn } from "node:child_process";

/** Env keys forwarded to host verify children — never ambient Jeeves secrets. */
export const VERIFY_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "USERPROFILE",
  "USERNAME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SystemRoot",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "TERM",
  "NODE_ENV",
  "npm_config_cache",
] as const;

export type VerifyCommandsResult =
  | { status: "skipped"; reason: string }
  | { status: "passed" }
  | {
      status: "failed";
      command: string;
      exitCode: number;
      message: string;
    };

export type VerifyCommandRunner = (
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Parse `projects.verify_commands` JSON text into an ordered command list.
 * Null / empty / `[]` means "no gate" (caller skips with a warning).
 */
export function parseVerifyCommands(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("projects.verify_commands must be a JSON array of strings");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("projects.verify_commands must be a JSON array of strings");
  }
  if (parsed.length === 0) return null;
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("projects.verify_commands must be a JSON array of strings");
    }
  }
  return parsed.map((c) => (c as string).trim());
}

/** Pick allowlisted keys from the current process env for verify children. */
export function verifyChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of VERIFY_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface RunVerifyCommandsInput {
  commands: string[] | null;
  cwd: string;
  log: (line: string) => void;
  runCommand?: VerifyCommandRunner;
}

/** Host gate: run ordered Jeeves-owned shell commands in the worktree. */
export async function runVerifyCommands(
  input: RunVerifyCommandsInput,
): Promise<VerifyCommandsResult> {
  const { commands, cwd, log } = input;
  if (commands == null || commands.length === 0) {
    const reason = "no verify_commands configured";
    log(`verify_commands: skip (${reason}; null/empty)`);
    return { status: "skipped", reason };
  }

  const runCommand = input.runCommand ?? defaultVerifyCommandRunner;
  const env = verifyChildEnv();

  for (const command of commands) {
    log(`verify_commands: running: ${command}`);
    const { exitCode, stdout, stderr } = await runCommand(command, { cwd, env });
    if (stdout) log(stdout.replace(/\n$/, ""));
    if (stderr) log(stderr.replace(/\n$/, ""));
    if (exitCode !== 0) {
      const message = `verify_commands failed: ${command} (exit ${exitCode})`;
      log(message);
      return { status: "failed", command, exitCode, message };
    }
  }

  log("verify_commands: all commands passed");
  return { status: "passed" };
}

/** Default shell runner — `shell: true` so project scripts like `npm test` work. */
export function defaultVerifyCommandRunner(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
