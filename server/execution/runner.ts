/**
 * AgentRunner — the inner seam of the ExecutionEngine (ADR 0008). Today's
 * implementation is Sandcastle + cursor; a future HarnessAgent adapter swaps
 * in here without touching the queue, routes, or UI.
 */

export interface RunAgentOptions {
  /** Host path of the target repo the agent works on. */
  cwd: string;
  /** Isolated branch for the run's worktree (never `head`). */
  branch: string;
  /** Host path where the full run log is persisted. */
  logPath: string;
  /** Cancels the in-flight run (graceful server shutdown). */
  signal?: AbortSignal;
}

export type RunEvent =
  | { type: "log"; line: string }
  | {
      /** Terminal event: the run resolved. Zero commits is the caller's
       *  call to make (tracer treats it as failure). */
      type: "result";
      commits: number;
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
    };

/** A failing run is signalled by the iterable throwing. */
export interface AgentRunner {
  run(promptFile: string, options: RunAgentOptions): AsyncIterable<RunEvent>;
}
