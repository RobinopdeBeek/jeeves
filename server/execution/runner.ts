/**
 * AgentRunner — the inner seam of the ExecutionEngine (ADR 0008). Today's
 * implementation is @cursor/sdk local; a future HarnessAgent adapter swaps
 * in here without touching the queue, routes, or UI.
 */

export interface RunAgentOptions {
  /** Host path of the target repo the agent works on. */
  cwd: string;
  /** Durable branch for the card's worktree (never `head`). */
  branch: string;
  /** Ephemeral worktree checkout path for this run. */
  worktreePath: string;
  /** Base SHA the worktree was created from. */
  baseSha: string;
  /** Host path where the full run log is persisted. */
  logPath: string;
  /** Cancels the in-flight run (graceful server shutdown). */
  signal?: AbortSignal;
  /** Called after the SDK run resolves, before worktree teardown. */
  onFinalize?: (ctx: RunFinalizeContext) => Promise<void>;
}

export interface RunFinalizeContext {
  workspacePath: string;
  headSha: string;
  baseSha: string;
}

export type RunEvent =
  | { type: "log"; line: string }
  | {
      /** Terminal event: the run resolved. */
      type: "result";
      status: "finished" | "cancelled";
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
    };

/** A failing run is signalled by the iterable throwing. */
export interface AgentRunner {
  run(promptFile: string, options: RunAgentOptions): AsyncIterable<RunEvent>;
}
