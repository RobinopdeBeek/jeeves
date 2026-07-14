import { Hono } from "hono";
import { CardStoreError, type KindPath } from "../cards/store.js";
import type { CardStore } from "../cards/store.js";
import type { Project } from "../db/schema.js";
import type { ExecutionEngine } from "../execution/engine.js";
import type { EventBus } from "../execution/events.js";
import type { RunStore } from "../execution/run-store.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { artifactRoutes } from "./artifacts.js";

function isKindPath(value: unknown): value is KindPath {
  return value === "feature" || value === "standalone";
}

export interface CardRouteDeps {
  engine: ExecutionEngine;
  runs: RunStore;
  events: EventBus;
  artifacts: ArtifactStore;
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
      const card = store.decideKind(c.req.param("id"), body.path);
      // Board tabs open elsewhere only see decide via SSE — not the HTTP response.
      deps.events.emit({ type: "card.updated", card });
      // Orchestration lives here, not in CardStore (ADR 0006): the
      // standalone path leaves Plan queued — hand it to the engine.
      if (card.steps.some((s) => s.key === "plan" && s.status === "queued")) {
        deps.engine.enqueue(card.id, "plan");
      }
      return c.json(card);
    } catch (e) {
      if (e instanceof CardStoreError) {
        return c.json({ error: e.message }, e.status as 400 | 404 | 409);
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
    const deleted = store.deleteCard(c.req.param("id"));
    return deleted
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404);
  });

  return app;
}
