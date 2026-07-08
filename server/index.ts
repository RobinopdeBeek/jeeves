import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CardStore } from "./cards/store.js";
import { openDb } from "./db/index.js";
import { ExecutionEngine } from "./execution/engine.js";
import { EventBus } from "./execution/events.js";
import { RunStore } from "./execution/run-store.js";
import { SandcastleAgentRunner } from "./execution/sandcastle-runner.js";
import { cardRoutes } from "./routes/cards.js";
import { eventRoutes } from "./routes/events.js";
import { runRoutes } from "./routes/runs.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // No .env file — environment variables come from the shell.
}
const dataDir = path.join(rootDir, "data");
const dbPath = process.env.JEEVES_DB_PATH ?? path.join(dataDir, "jeeves.db");
const repoPath = process.env.JEEVES_REPO_PATH ?? rootDir;
const port = Number(process.env.JEEVES_PORT ?? 3000);

const db = openDb(dbPath);
const store = new CardStore(db);
const project = store.ensureDefaultProject(path.basename(repoPath), repoPath);

const events = new EventBus();
const runs = new RunStore(db);
const engine = new ExecutionEngine({
  store,
  runs,
  runner: new SandcastleAgentRunner(),
  events,
  artifactRoot: dataDir,
});

const app = new Hono();

app.get("/api/project", (c) => c.json(project));
app.route("/api/cards", cardRoutes(store, project, { engine, runs }));
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
