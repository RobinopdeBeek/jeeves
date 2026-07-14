import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "./artifacts/store.js";
import { CardStore } from "./cards/store.js";
import { openDb } from "./db/index.js";
import { ensureProjectStore } from "./project-store.js";
import { CursorSdkAgentRunner } from "./execution/cursor-sdk-runner.js";
import { ExecutionEngine } from "./execution/engine.js";
import { EventBus } from "./execution/events.js";
import { RunStore } from "./execution/run-store.js";
import { WorktreeManager } from "./execution/worktree-manager.js";
import { cardRoutes } from "./routes/cards.js";
import { eventRoutes } from "./routes/events.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { runRoutes } from "./routes/runs.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // No .env file — environment variables come from the shell.
}
const repoPath = path.resolve(process.env.JEEVES_REPO_PATH ?? rootDir);
const paths = ensureProjectStore(repoPath);
const port = Number(process.env.JEEVES_PORT ?? 3939);

const db = openDb(paths.dbPath);
const store = new CardStore(db);
const project = store.ensureDefaultProject(path.basename(paths.repoPath), paths.repoPath);

const events = new EventBus();
const runs = new RunStore(db);
const artifacts = new ArtifactStore(db, paths.artifactRoot);
const worktrees = new WorktreeManager({
  repoPath: paths.repoPath,
  worktreeRoot: paths.worktreeRoot,
});
const engine = new ExecutionEngine({
  store,
  runs,
  runner: new CursorSdkAgentRunner(),
  worktrees,
  artifacts,
  events,
  repoRoot: rootDir,
});

const app = new Hono();

app.get("/api/project", (c) => c.json(project));
app.route("/api/cards", cardRoutes(store, project, { engine, runs, events, artifacts }));
app.route("/api/runs", runRoutes(runs));
app.route("/api/events", eventRoutes(events));

// Production client build. serveStatic roots are relative to the process
// cwd, so run the server from the repo root (npm start does).
app.use("/*", serveStatic({ root: "./client/dist" }));
app.get("*", serveStatic({ path: "./client/dist/index.html" }));

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`jeeves board on http://0.0.0.0:${info.port} (project: ${project.name})`);
  // Boot hooks after listen: orphan recovery first, then queued-step scan.
  engine.boot();
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — cancelling in-flight run…`);
  await engine.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
