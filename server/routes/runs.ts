import fs from "node:fs";
import { Hono } from "hono";
import type { RunStore } from "../execution/run-store.js";

const LOG_TAIL_CHARS = 64_000;

/** Run metadata + log tail — what a reconnecting client needs to catch up. */
export function runRoutes(runs: RunStore) {
  const app = new Hono();

  app.get("/:id", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ ...run, log: readLogTail(run.logPath) });
  });

  return app;
}

export function readLogTail(logPath: string | null): string {
  if (!logPath) return "";
  try {
    const content = fs.readFileSync(logPath, "utf8");
    return content.length > LOG_TAIL_CHARS
      ? content.slice(-LOG_TAIL_CHARS)
      : content;
  } catch {
    return "";
  }
}
