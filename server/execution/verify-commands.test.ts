import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseVerifyCommands,
  runVerifyCommands,
  type VerifyCommandRunner,
} from "./verify-commands.js";

describe("parseVerifyCommands", () => {
  it("returns null for null, empty string, empty array, and whitespace JSON array", () => {
    expect(parseVerifyCommands(null)).toBeNull();
    expect(parseVerifyCommands("")).toBeNull();
    expect(parseVerifyCommands("[]")).toBeNull();
    expect(parseVerifyCommands("  null  ")).toBeNull();
  });

  it("parses an ordered JSON string array", () => {
    expect(parseVerifyCommands('["npm test", "npm run build"]')).toEqual([
      "npm test",
      "npm run build",
    ]);
  });

  it("rejects non-array or non-string entries", () => {
    expect(() => parseVerifyCommands("{}")).toThrow(/verify_commands/i);
    expect(() => parseVerifyCommands('["ok", 1]')).toThrow(/verify_commands/i);
  });
});

describe("runVerifyCommands", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function tmpWorktree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-verify-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("skips with a warning when commands are null or empty", async () => {
    const warn = vi.fn();
    const runCommand = vi.fn();
    const result = await runVerifyCommands({
      commands: null,
      cwd: tmpWorktree(),
      log: warn,
      runCommand,
    });
    expect(result).toEqual({ status: "skipped", reason: "no verify_commands configured" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/verify_commands.*(skip|empty|null)/i),
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("runs commands in order in the worktree and succeeds", async () => {
    const cwd = tmpWorktree();
    const log = vi.fn();
    const runCommand: VerifyCommandRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    }));

    const result = await runVerifyCommands({
      commands: ["npm test", "npm run build"],
      cwd,
      log,
      runCommand,
    });

    expect(result).toEqual({ status: "passed" });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "npm test",
      expect.objectContaining({ cwd }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "npm run build",
      expect.objectContaining({ cwd }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("npm test"));
  });

  it("fails on the first non-zero exit with log evidence", async () => {
    const cwd = tmpWorktree();
    const log = vi.fn();
    const runCommand: VerifyCommandRunner = vi.fn(async (command) => {
      if (command === "npm test") {
        return { exitCode: 0, stdout: "pass\n", stderr: "" };
      }
      return { exitCode: 2, stdout: "", stderr: "build failed\n" };
    });

    const result = await runVerifyCommands({
      commands: ["npm test", "npm run build"],
      cwd,
      log,
      runCommand,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.command).toBe("npm run build");
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/npm run build/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("build failed"));
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("passes only allowlisted env vars to the child", async () => {
    const cwd = tmpWorktree();
    const runCommand: VerifyCommandRunner = vi.fn(async (_cmd, opts) => {
      expect(opts.env).toEqual(
        expect.objectContaining({
          PATH: expect.any(String),
        }),
      );
      expect(opts.env).not.toHaveProperty("CURSOR_API_KEY");
      expect(opts.env).not.toHaveProperty("SECRET_TOKEN");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const prev = process.env.CURSOR_API_KEY;
    const prevSecret = process.env.SECRET_TOKEN;
    process.env.CURSOR_API_KEY = "should-not-leak";
    process.env.SECRET_TOKEN = "nope";
    try {
      await runVerifyCommands({
        commands: ["echo hi"],
        cwd,
        log: () => {},
        runCommand,
      });
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
      if (prevSecret === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = prevSecret;
    }

    expect(runCommand).toHaveBeenCalled();
  });
});
