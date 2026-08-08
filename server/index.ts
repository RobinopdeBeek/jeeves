import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ArtifactStore } from "./artifacts/store.js";
import { CardAttachmentStore } from "./attachments/card-library.js";
import { CardStore } from "./cards/store.js";
import { ChatThreadStore } from "./chat-threads/store.js";
import { openDb } from "./db/index.js";
import { ensureProjectStore } from "./project-store.js";
import { CursorSdkAgentRunner } from "./execution/cursor-sdk-runner.js";
import { ExecutionEngine } from "./execution/engine.js";
import { EventBus } from "./execution/events.js";
import { RunStore } from "./execution/run-store.js";
import { WorktreeManager } from "./execution/worktree-manager.js";
import { isStepKey } from "./pipelines.js";
import { extractGrillSession } from "./chat/grill-session-extract.js";
import { createCreateSpec } from "./chat/create-spec.js";
import { createCreateTasks } from "./chat/create-tasks.js";
import { createSynthesizeSpec } from "./chat/to-spec-synthesis.js";
import { createSynthesizeTasksDraft } from "./chat/to-tasks-synthesis.js";
import { cardRoutes } from "./routes/cards.js";
import { chatThreadRoutes } from "./routes/chat-threads.js";
import { eventRoutes } from "./routes/events.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { modelRoutes } from "./routes/models.js";
import { runRoutes } from "./routes/runs.js";
import { ChatSessionRegistry } from "./ws/session-registry.js";
import { spawnAcp } from "./ws/acp-process.js";
import { ChatConnection } from "./ws/attach.js";
import { ProjectChat } from "./ws/project-chat.js";

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
const artifacts = new ArtifactStore(db, paths.artifactRoot);
const cardAttachments = new CardAttachmentStore(db, paths.artifactRoot);
const store = new CardStore(db, artifacts);
const chatThreads = new ChatThreadStore(db, paths.chatRoot);
const project = store.ensureDefaultProject(path.basename(paths.repoPath), paths.repoPath);

const events = new EventBus();
const runs = new RunStore(db);
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

const chatSessions = new ChatSessionRegistry();
const projectChat = new ProjectChat({
  threads: chatThreads,
  spawn: spawnAcp,
  sessions: chatSessions,
  cwd: paths.repoPath,
});
const chatDeps = {
  store,
  artifacts,
  events,
  spawn: spawnAcp,
  promptsRoot: path.join(rootDir, "prompts"),
  sessions: chatSessions,
  chatThreads,
  projectCwd: paths.repoPath,
};

const app = new Hono();

app.get("/api/project", (c) => c.json(project));
app.route("/api/models", modelRoutes());
app.route("/api/chat-threads", chatThreadRoutes(chatThreads, project, projectChat));
app.route(
  "/api/cards",
  cardRoutes(store, project, {
    engine,
    runs,
    events,
    artifacts,
    cardAttachments,
    sessions: chatSessions,
    spawn: spawnAcp,
    createSpec: createCreateSpec({
      store,
      artifacts,
      sessions: chatSessions,
      engine,
      events,
      extractGrillSession,
      synthesizeSpec: createSynthesizeSpec({ spawn: spawnAcp, artifacts }),
    }),
    createTasks: createCreateTasks({
      store,
      artifacts,
      sessions: chatSessions,
      engine,
      events,
      runs,
      synthesizeTasksDraft: createSynthesizeTasksDraft({
        spawn: spawnAcp,
        artifacts,
      }),
    }),
    promptsRoot: path.join(rootDir, "prompts"),
  }),
);
app.route("/api/runs", runRoutes(runs));
app.route("/api/events", eventRoutes(events));

app.get(
  "/ws/chat",
  upgradeWebSocket((c) => {
    const threadId = c.req.query("threadId");
    const cardId = c.req.query("cardId");
    const stepKey = c.req.query("stepKey");
    const round = Number(c.req.query("round") ?? "0");

    const openTarget =
      threadId != null && threadId !== ""
        ? ({ kind: "thread", ref: { threadId } } as const)
        : cardId && isStepKey(stepKey) && !Number.isNaN(round)
          ? ({
              kind: "step",
              ref: { cardId, stepKey, round },
            } as const)
          : null;

    if (!openTarget) {
      return {
        onOpen(_event, ws) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: "threadId or cardId+stepKey+round required",
            }),
          );
          ws.close();
        },
      };
    }

    let connection: ChatConnection | null = null;
    return {
      onOpen(_event, ws) {
        connection = new ChatConnection(ws, openTarget, chatDeps);
        void connection.start();
      },
      onMessage(event, _ws) {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        void connection?.onClientMessage(data);
      },
      onClose() {
        connection?.close();
        connection = null;
      },
    };
  }),
);

// Production client build. serveStatic roots are relative to the process
// cwd, so run the server from the repo root (npm start does).
app.use("/*", serveStatic({ root: "./client/dist" }));
app.get("*", serveStatic({ path: "./client/dist/index.html" }));

const wss = new WebSocketServer({ noServer: true });
const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
    websocket: { server: wss },
  },
  (info) => {
    console.log(`jeeves board on http://0.0.0.0:${info.port} (project: ${project.name})`);
    // Boot hooks after listen: orphan recovery first, then queued-step scan.
    engine.boot();
  },
);

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
