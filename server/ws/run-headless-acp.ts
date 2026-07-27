import {
  AcpBridge,
  AcpHeadlessError,
  type HeadlessPermissionPolicy,
  type SpawnAcp,
} from "./chat.js";

export { AcpHeadlessError };

export interface RunHeadlessAcpOptions {
  spawn: SpawnAcp;
  cwd: string;
  prompt: string;
  permissionPolicy: HeadlessPermissionPolicy;
  /** Fail the run if the turn does not finish within this window. */
  timeoutMs?: number;
}

/**
 * One-shot headless ACP turn for host ops (e.g. /to-spec).
 * Owns a throwaway AcpBridge — interactive chat never grows for synthesis.
 */
export async function runHeadlessAcp(options: RunHeadlessAcpOptions): Promise<void> {
  const bridge = new AcpBridge({ spawn: options.spawn });
  await bridge.runToCompletion({
    cwd: options.cwd,
    prompt: options.prompt,
    permissionPolicy: options.permissionPolicy,
    timeoutMs: options.timeoutMs,
  });
}
