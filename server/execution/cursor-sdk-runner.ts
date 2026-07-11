import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Code, ConnectError } from "@connectrpc/connect";
import { Agent, CursorAgentError } from "@cursor/sdk";
import type { LocalAgentOptions, Run, SDKMessage } from "@cursor/sdk";
import type { AgentRunner, RunAgentOptions, RunEvent } from "./runner.js";

const execFileAsync = promisify(execFile);

const MODEL = "composer-2.5";

/**
 * AgentRunner over @cursor/sdk local agents (ADR 0010). Each run works in a
 * self-managed git worktree; Jeeves tees `run.stream()` to `logPath`.
 */
export class CursorSdkAgentRunner implements AgentRunner {
  async *run(
    promptFile: string,
    options: RunAgentOptions,
  ): AsyncIterable<RunEvent> {
    const { worktreePath, baseSha } = options;

    const apiKey = process.env.CURSOR_API_KEY?.trim();
    if (!apiKey) throw new Error("CURSOR_API_KEY is not set");

    const prompt = fs.readFileSync(promptFile, "utf8");
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
    const log = fs.createWriteStream(options.logPath, { flags: "w" });

    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    let run: Run | undefined;

    const onAbort = () => {
      if (run?.supports("cancel")) void run.cancel();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      agent = await Agent.create({
        apiKey,
        model: { id: MODEL },
        local: localOptions(worktreePath),
      });

      run = await agent.send(prompt);

      for await (const event of run.stream()) {
        options.signal?.throwIfAborted();
        const line = formatMessage(event);
        if (line !== undefined) {
          log.write(`${line}\n`);
          yield { type: "log", line };
        }
      }

      const result = await safeWait(run);

      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("aborted");
      }

      if (result.status === "error") {
        throw new Error(`agent run failed (${result.id})`);
      }

      if (result.status === "cancelled") {
        yield { type: "result", status: "cancelled" };
        return;
      }

      const headSha = await gitRevParse(worktreePath, "HEAD");
      if (options.onFinalize) {
        await options.onFinalize({
          workspacePath: worktreePath,
          headSha,
          baseSha,
        });
      }

      yield {
        type: "result",
        status: "finished",
        model: result.model?.id ?? MODEL,
      };
    } catch (error) {
      if (options.signal?.aborted && isCanceledError(error)) {
        throw options.signal.reason ?? new Error("aborted");
      }
      if (error instanceof CursorAgentError) throw error;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      log.end();
      if (agent) await safeDispose(agent);
    }
  }
}

function localOptions(worktreePath: string): LocalAgentOptions {
  const local: LocalAgentOptions = {
    cwd: worktreePath,
    settingSources: [],
  };
  if (process.platform !== "win32") {
    local.sandboxOptions = { enabled: true };
  }
  return local;
}

function formatMessage(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    return message.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  if (message.type === "tool_call") {
    return `→ ${message.name} (${message.status})`;
  }
  return undefined;
}

async function safeWait(run: Run) {
  try {
    return await run.wait();
  } catch (error) {
    if (isCanceledError(error)) {
      return { id: run.id, status: "cancelled" as const };
    }
    throw error;
  }
}

async function safeDispose(agent: AsyncDisposable): Promise<void> {
  try {
    await agent[Symbol.asyncDispose]();
  } catch (error) {
    if (!isCanceledError(error)) throw error;
  }
}

function isCanceledError(error: unknown): boolean {
  if (error instanceof ConnectError) {
    return error.code === Code.Canceled || /\[canceled\]/i.test(error.message);
  }
  if (error instanceof CursorAgentError && error.cause) {
    return isCanceledError(error.cause);
  }
  if (error instanceof Error && /\[canceled\]/i.test(error.message)) {
    return true;
  }
  return false;
}

async function gitRevParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", ref]);
  return stdout.trim();
}
