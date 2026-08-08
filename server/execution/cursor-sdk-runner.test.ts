import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentCreate = vi.fn();

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => agentCreate(...args),
  },
  CursorAgentError: class CursorAgentError extends Error {
    cause?: unknown;
    constructor(message?: string, options?: { cause?: unknown }) {
      super(message);
      this.cause = options?.cause;
    }
  },
}));

import {
  CursorSdkAgentRunner,
  EXECUTION_SETTING_SOURCES,
} from "./cursor-sdk-runner.js";

function initGitRepo(dir: string): string {
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README"), "x\n");
  execFileSync("git", ["add", "README"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
    .toString()
    .trim();
}

describe("CursorSdkAgentRunner local settingSources", () => {
  let worktreePath: string;
  let logPath: string;
  let baseSha: string;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "test-key";
    worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-sdk-wt-"));
    baseSha = initGitRepo(worktreePath);
    logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-sdk-log-")),
      "run.log",
    );

    agentCreate.mockReset();
    agentCreate.mockResolvedValue({
      send: vi.fn(async () => ({
        id: "run-1",
        supports: () => false,
        stream: async function* () {},
        wait: async () => ({
          id: "run-1",
          status: "finished",
          model: { id: "composer-2.5" },
        }),
        cancel: async () => {},
      })),
      [Symbol.asyncDispose]: async () => {},
    });
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
  });

  it("loads project and user ambient settings so host MCP (Context7) can attach", async () => {
    const runner = new CursorSdkAgentRunner();
    const events = [];
    for await (const event of runner.run("plan this slice", {
      cwd: worktreePath,
      branch: "jeeves/card-1",
      worktreePath,
      baseSha,
      logPath,
    })) {
      events.push(event);
    }

    expect(agentCreate).toHaveBeenCalledOnce();
    const createArg = agentCreate.mock.calls[0]?.[0] as {
      local: { cwd: string; settingSources: string[] };
    };
    expect(createArg.local.cwd).toBe(worktreePath);
    // Spec #64: not [] — project + user load host/project mcp.json (Context7).
    expect(EXECUTION_SETTING_SOURCES).toEqual(["project", "user"]);
    expect(createArg.local.settingSources).toEqual([
      ...EXECUTION_SETTING_SOURCES,
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "finished",
    });
  });
});
