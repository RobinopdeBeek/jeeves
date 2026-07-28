import { Hono } from "hono";
import { CardStoreError, type KindPath } from "../cards/store.js";
import type { CardStore } from "../cards/store.js";
import type { Project } from "../db/schema.js";
import {
  CreateSpecError,
  type CreateSpec,
} from "../chat/create-spec.js";
import {
  CreateTasksError,
  type CreateTasks,
} from "../chat/create-tasks.js";
import { dispatchAdvanceEffects } from "../execution/dispatch-effects.js";
import type { ExecutionEngine } from "../execution/engine.js";
import type { EventBus } from "../execution/events.js";
import type { RunStore } from "../execution/run-store.js";
import {
  ArtifactStoreError,
  type ArtifactStore,
} from "../artifacts/store.js";
import {
  parseTasksDraft,
  TasksDraftError,
} from "../artifacts/tasks-draft.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";
import { artifactRoutes } from "./artifacts.js";

function isKindPath(value: unknown): value is KindPath {
  return value === "feature" || value === "standalone";
}

function tasksDraftErrorStatus(err: unknown): number | null {
  if (err instanceof TasksDraftError) return 400;
  if (err instanceof ArtifactStoreError) {
    return err.message === "nothing to undo" ? 409 : 400;
  }
  if (err instanceof CardStoreError) return err.status;
  return null;
}

export interface CardRouteDeps {
  engine: ExecutionEngine;
  runs: RunStore;
  events: EventBus;
  artifacts: ArtifactStore;
  sessions: ChatSessionRegistry;
  createSpec: CreateSpec;
  createTasks: CreateTasks;
  promptsRoot: string;
}

/** Thin HTTP adapter over the CardStore seam. */
export function cardRoutes(
  store: CardStore,
  project: Project,
  deps: CardRouteDeps,
) {
  const app = new Hono();

  app.get("/", (c) => c.json(store.listCards(project.id)));

  app.post("/", (c) => c.json(store.createCard(project.id), 201));

  app.get("/:id", (c) => {
    const card = store.getCard(c.req.param("id"));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  app.patch("/:id", async (c) => {
    const body = await c.req.json<{ title?: string; description?: string }>();
    const card = store.updateCard(c.req.param("id"), body);
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  app.post("/:id/decide", async (c) => {
    const body = await c.req.json<{ path?: unknown }>();
    if (!isKindPath(body.path)) {
      return c.json({ error: "path must be feature or standalone" }, 400);
    }
    try {
      const { card, sideEffects } = store.decideKind(
        c.req.param("id"),
        body.path,
      );
      // Board tabs open elsewhere only see decide via SSE — not the HTTP response.
      deps.events.emit({ type: "card.updated", card });
      // advance declares enqueue; route only dispatches (ADR 0006).
      dispatchAdvanceEffects(card.id, sideEffects, {
        enqueue: (id, step) => deps.engine.enqueue(id, step),
        sessions: deps.sessions,
      });
      return c.json(card);
    } catch (e) {
      if (e instanceof CardStoreError) {
        return c.json({ error: e.message }, e.status as 400 | 404 | 409);
      }
      throw e;
    }
  });

  app.post("/:id/create-spec", async (c) => {
    const cardId = c.req.param("id");
    try {
      const card = await deps.createSpec({
        cardId,
        repoPath: project.repoPath,
        promptsRoot: deps.promptsRoot,
      });
      // createSpec emits card.updated when synthesis starts and when it settles.
      return c.json(card);
    } catch (e) {
      if (e instanceof CreateSpecError) {
        return c.json({ error: e.message }, e.status as 422 | 502);
      }
      if (e instanceof CardStoreError) {
        return c.json({ error: e.message }, e.status as 400 | 404 | 409);
      }
      throw e;
    }
  });

  app.put("/:id/spec", async (c) => {
    const cardId = c.req.param("id");
    try {
      const body = await c.req.json<{ content?: unknown }>();
      if (typeof body.content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      store.assertSpecMutable(cardId);
      const artifact = deps.artifacts.upsertSpec(cardId, 0, body.content);
      return c.json({
        id: artifact.id,
        cardId: artifact.cardId,
        stepKey: artifact.stepKey,
        round: artifact.round,
        kind: artifact.kind,
        gitSha: artifact.gitSha,
        createdAt: artifact.createdAt.toISOString(),
        content: deps.artifacts.readBody(artifact),
      });
    } catch (e) {
      if (e instanceof CardStoreError) {
        return c.json({ error: e.message }, e.status as 400 | 404 | 409);
      }
      throw e;
    }
  });

  app.post("/:id/create-tasks", async (c) => {
    const cardId = c.req.param("id");
    try {
      const card = await deps.createTasks({
        cardId,
        repoPath: project.repoPath,
        promptsRoot: deps.promptsRoot,
      });
      // createTasks emits card.updated when synthesis starts and when it settles.
      return c.json(card);
    } catch (e) {
      if (e instanceof CreateTasksError) {
        return c.json({ error: e.message }, e.status as 422 | 502);
      }
      if (e instanceof CardStoreError) {
        return c.json({ error: e.message }, e.status as 400 | 404 | 409);
      }
      throw e;
    }
  });

  app.get("/:id/tasks", (c) => {
    const cardId = c.req.param("id");
    const card = store.getCard(cardId);
    if (!card) return c.json({ error: "not found" }, 404);
    return c.json({
      ...deps.artifacts.readTasksDraftTip(cardId, 0),
      versionCount: deps.artifacts.tasksDraftVersionCount(cardId, 0),
    });
  });

  app.put("/:id/tasks", async (c) => {
    const cardId = c.req.param("id");
    try {
      store.assertTasksDraftMutable(cardId);
      const body = await c.req.json();
      const draft = parseTasksDraft(body);
      deps.artifacts.appendTasksDraft(cardId, 0, draft, "human");
      return c.json({
        ...deps.artifacts.readTasksDraftTip(cardId, 0),
        versionCount: deps.artifacts.tasksDraftVersionCount(cardId, 0),
      });
    } catch (e) {
      const status = tasksDraftErrorStatus(e);
      if (status !== null) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          status as 400 | 404 | 409,
        );
      }
      throw e;
    }
  });

  app.delete("/:id/tasks/:taskId", (c) => {
    const cardId = c.req.param("id");
    const taskId = c.req.param("taskId");
    try {
      store.assertTasksDraftMutable(cardId);
      const tip = deps.artifacts.deleteTaskFromTasksDraft(cardId, 0, taskId);
      return c.json({
        ...tip,
        versionCount: deps.artifacts.tasksDraftVersionCount(cardId, 0),
      });
    } catch (e) {
      const status = tasksDraftErrorStatus(e);
      if (status !== null) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          status as 400 | 404 | 409,
        );
      }
      throw e;
    }
  });

  app.post("/:id/tasks/undo", (c) => {
    const cardId = c.req.param("id");
    try {
      store.assertTasksDraftMutable(cardId);
      const tip = deps.artifacts.undoTasksDraft(cardId, 0);
      return c.json({
        ...tip,
        versionCount: deps.artifacts.tasksDraftVersionCount(cardId, 0),
      });
    } catch (e) {
      const status = tasksDraftErrorStatus(e);
      if (status !== null) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          status as 400 | 404 | 409,
        );
      }
      throw e;
    }
  });

  app.get("/:id/runs", (c) => {
    const card = store.getCard(c.req.param("id"));
    if (!card) return c.json({ error: "not found" }, 404);
    return c.json(deps.runs.listForCard(card.id));
  });

  app.route("/:id/artifacts", artifactRoutes(deps.artifacts));

  app.post("/:id/steps/:stepKey/retry", (c) => {
    const stepKey = c.req.param("stepKey");
    if (stepKey !== "plan") {
      return c.json({ error: "only the plan step is retryable in slice 4" }, 400);
    }
    try {
      return c.json(deps.engine.retry(c.req.param("id"), stepKey));
    } catch (e) {
      if (e instanceof CardStoreError) {
        return c.json({ error: e.message }, e.status as 404 | 409);
      }
      throw e;
    }
  });

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const deleted = store.deleteCard(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    deps.artifacts.removeCardFolder(id);
    return c.json({ ok: true });
  });

  return app;
}
