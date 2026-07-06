import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CardStore } from "./cards/store.js";
import { openDb } from "./db/index.js";
import { cardRoutes } from "./routes/cards.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.JEEVES_DB_PATH ?? path.join(rootDir, "data", "jeeves.db");
const repoPath = process.env.JEEVES_REPO_PATH ?? rootDir;
const port = Number(process.env.JEEVES_PORT ?? 3000);

const db = openDb(dbPath);
const store = new CardStore(db);
const project = store.ensureDefaultProject(path.basename(repoPath), repoPath);

const app = new Hono();

app.get("/api/project", (c) => c.json(project));
app.route("/api/cards", cardRoutes(store, project));

// Production client build. serveStatic roots are relative to the process
// cwd, so run the server from the repo root (npm start does).
app.use("/*", serveStatic({ root: "./client/dist" }));
app.get("*", serveStatic({ path: "./client/dist/index.html" }));

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`jeeves board on http://0.0.0.0:${info.port} (project: ${project.name})`);
});
