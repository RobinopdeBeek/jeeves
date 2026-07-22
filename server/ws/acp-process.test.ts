import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpSpawnError, resolveAgentLaunch } from "./acp-process.js";

describe("resolveAgentLaunch", () => {
  const prevBin = process.env.JEEVES_AGENT_BIN;
  const prevPath = process.env.PATH;
  let tempDir: string | undefined;

  afterEach(() => {
    if (prevBin === undefined) delete process.env.JEEVES_AGENT_BIN;
    else process.env.JEEVES_AGENT_BIN = prevBin;
    process.env.PATH = prevPath;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("uses JEEVES_AGENT_BIN when set", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-agent-"));
    const bin = path.join(tempDir, process.platform === "win32" ? "agent.cmd" : "agent");
    fs.writeFileSync(bin, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n");
    process.env.JEEVES_AGENT_BIN = bin;

    const launch = resolveAgentLaunch();
    expect(launch.command).toBe(bin);
    expect(launch.shell).toBe(process.platform === "win32");
  });

  it("throws a clear error when agent is missing", () => {
    delete process.env.JEEVES_AGENT_BIN;
    const options = {
      pathEnv: path.join(os.tmpdir(), "jeeves-empty-path-no-agent"),
      wellKnownPaths: [],
    };

    expect(() => resolveAgentLaunch(options)).toThrow(AcpSpawnError);
    expect(() => resolveAgentLaunch(options)).toThrow(/not found/i);
  });
});
