import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cursor,
  run as sandcastleRun,
  type AgentStreamEvent,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { AgentRunner, RunAgentOptions, RunEvent } from "./runner.js";

const execFileAsync = promisify(execFile);

const MODEL = "composer-2.5";

/**
 * AgentRunner over Sandcastle + cursor (ADR 0008). Sandbox provider chosen
 * at spike time: Docker (the PRD's expected path). Each run works in an
 * isolated branch worktree — never Docker's default `head` strategy, which
 * would write straight into the host working tree.
 *
 * Sandcastle writes the full log to `logPath` itself (`logging.type: "file"`);
 * this class only forwards live stream events to the caller.
 */
export class SandcastleAgentRunner implements AgentRunner {
  async *run(
    promptFile: string,
    options: RunAgentOptions,
  ): AsyncIterable<RunEvent> {
    const buffer: RunEvent[] = [];
    let notify: (() => void) | undefined;
    const push = (event: RunEvent) => {
      buffer.push(event);
      notify?.();
    };

    const runPromise = sandcastleRun({
      agent: cursor(MODEL),
      sandbox: docker(),
      cwd: options.cwd,
      promptFile,
      branchStrategy: { type: "branch", branch: options.branch },
      signal: options.signal,
      logging: {
        type: "file",
        path: options.logPath,
        onAgentStreamEvent: (event: AgentStreamEvent) => {
          const line = formatStreamEvent(event);
          if (line !== undefined) push({ type: "log", line });
        },
      },
    });
    // Track settlement without racing an un-awaited rejection past the loop.
    let settled: { commits: number } | { error: unknown } | undefined;
    void runPromise.then(
      (result) => {
        settled = { commits: result.commits.length };
        notify?.();
      },
      (error) => {
        settled = { error };
        notify?.();
      },
    );

    while (true) {
      while (buffer.length > 0) yield buffer.shift()!;
      if (settled) break;
      await new Promise<void>((resolve) => (notify = resolve));
      notify = undefined;
    }

    if ("error" in settled!) throw settled!.error;
    const result = await runPromise;
    const commits = result.commits.length;
    if (commits > 0) await this.deleteBranch(options.cwd, options.branch);
    // cursor doesn't support usage parsing today — fields stay null unless
    // Sandcastle starts returning usage for it.
    const usage = result.iterations.at(-1)?.usage;
    yield {
      type: "result",
      commits,
      model: MODEL,
      tokensIn: usage?.inputTokens,
      tokensOut: usage?.outputTokens,
    };
  }

  /**
   * Sandcastle removes the clean worktree after the tracer's commit; the
   * leftover branch is jeeves' to clean up. Failed/dirty runs keep their
   * branch (and preserved worktree) for debugging.
   */
  private async deleteBranch(cwd: string, branch: string): Promise<void> {
    try {
      await execFileAsync("git", ["-C", cwd, "branch", "-D", branch]);
    } catch {
      // Non-fatal: a stale branch is debris, not a failed run.
    }
  }
}

function formatStreamEvent(event: AgentStreamEvent): string | undefined {
  switch (event.type) {
    case "text":
      return event.message;
    case "toolCall":
      return `→ ${event.name} ${event.formattedArgs}`;
    case "raw":
      return undefined; // verbose-only noise
  }
}
