import { Hono } from "hono";
import { CardStoreError, type KindPath } from "../cards/store.js";
import type { CardStore } from "../cards/store.js";
import type { Project } from "../db/schema.js";
import {
  GrillSessionExtractError,
  type ExtractGrillSession,
} from "../chat/grill-session-extract.js";
import { dispatchAdvanceEffects } from "../execution/dispatch-effects.js";
import type { ExecutionEngine } from "../execution/engine.js";
import type { EventBus } from "../execution/events.js";
import type { RunStore } from "../execution/run-store.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { loadTranscript } from "../ws/open-chat.js";
import type { ChatSessionRegistry } from "../ws/session-registry.js";
import { artifactRoutes } from "./artifacts.js";

function isKindPath(value: unknown): value is KindPath {
  return value === "feature" || value === "standalone";
}

export interface CardRouteDeps {
  engine: ExecutionEngine;
  runs: RunStore;
  events: EventBus;
  artifacts: ArtifactStore;
  sessions: ChatSessionRegistry;
  extractGrillSession: ExtractGrillSession;
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
      // Validate before extract / ACP teardown so a 409 leaves the session intact.
      const plan = store.assertGrillToSpecHandOff(cardId);

      const transcript = loadTranscript(deps.artifacts, {
        cardId,
        stepKey: "grill",
        round: 0,
      });
      if (transcript.length === 0) {
        return c.json({ error: "grill transcript is empty" }, 422);
      }

      let body: string;
      try {
        body = await deps.extractGrillSession({
          transcript,
          repoPath: project.repoPath,
          promptsRoot: deps.promptsRoot,
        });
      } catch (e) {
        const message =
          e instanceof GrillSessionExtractError
            ? e.message
            : e instanceof Error
              ? e.message
              : "grill-session extract failed";
        return c.json({ error: message }, 502);
      }

      deps.artifacts.save({
        cardId,
        stepKey: "grill",
        round: 0,
        kind: "grill",
        content: body,
        sourceSkill: "grill-session",
      });

      dispatchAdvanceEffects(cardId, plan.sideEffects, {
        enqueue: (id, step) => deps.engine.enqueue(id, step),
        sessions: deps.sessions,
      });
      const { card } = store.handOffGrillToSpec(cardId);
      deps.events.emit({ type: "card.updated", card });
      return c.json(card);
    } catch (e) {
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
      const plan = store.assertSpecToTasksHandOff(cardId);

      const latest = deps.artifacts.latest(cardId, {
        stepKey: "spec",
        round: 0,
        kind: "spec",
      });
      const markdown = latest ? deps.artifacts.readBody(latest) : "";
      if (!markdown.trim()) {
        return c.json({ error: "spec body is empty" }, 422);
      }

      dispatchAdvanceEffects(cardId, plan.sideEffects, {
        enqueue: (id, step) => deps.engine.enqueue(id, step),
        sessions: deps.sessions,
      });
      const { card } = store.handOffSpecToTasks(cardId);
      deps.events.emit({ type: "card.updated", card });
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
    const id = c.req.param("id");
    const deleted = store.deleteCard(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    deps.artifacts.removeCardFolder(id);
    return c.json({ ok: true });
  });

  return app;
}
