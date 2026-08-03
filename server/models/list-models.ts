/**
 * Parse `agent models` / `agent --list-models` human-readable stdout into
 * picker rows. Format (from Cursor Agent CLI):
 *   <id> - <display name> [(current[, ]default)]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAgentLaunch } from "../ws/acp-process.js";

const execFileAsync = promisify(execFile);

export interface AgentModel {
  id: string;
  displayName: string;
  current: boolean;
  default: boolean;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const MODEL_LINE_RE =
  /^(\S+)\s+-\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/;

/** Strip ANSI + parse model lines; ignore headers/blank/errors. */
export function parseAgentModelsOutput(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(ANSI_RE, "").trim();
    if (!line) continue;
    if (/^available models$/i.test(line)) continue;
    if (/^no models available/i.test(line)) continue;
    const match = MODEL_LINE_RE.exec(line);
    if (!match) continue;
    const id = match[1]!;
    const displayName = match[2]!.trim();
    const markers = (match[3] ?? "").toLowerCase();
    models.push({
      id,
      displayName,
      current: markers.includes("current"),
      default: markers.includes("default"),
    });
  }
  return models;
}

export class ListModelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListModelsError";
  }
}

export type RunAgentModels = () => Promise<string>;

/** Default host wrapper: `agent models` via the resolved Agent CLI. */
export async function runAgentModelsCli(): Promise<string> {
  const launch = resolveAgentLaunch();
  try {
    const { stdout } = await execFileAsync(
      launch.command,
      [...launch.args, "models"],
      {
        env: process.env,
        shell: launch.shell,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return typeof stdout === "string" ? stdout : String(stdout);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to list models";
    throw new ListModelsError(message);
  }
}

/** List models for the Project Chat picker (injectable for CI). */
export async function listAgentModels(
  run: RunAgentModels = runAgentModelsCli,
): Promise<AgentModel[]> {
  try {
    const stdout = await run();
    return parseAgentModelsOutput(stdout);
  } catch (err) {
    if (err instanceof ListModelsError) throw err;
    const message =
      err instanceof Error ? err.message : "failed to list models";
    throw new ListModelsError(message);
  }
}
