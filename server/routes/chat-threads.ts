import { Hono } from "hono";
import {
  ChatThreadStoreError,
  type ChatThreadStore,
} from "../chat-threads/store.js";
import type { Project } from "../db/schema.js";

/** Thin HTTP adapter over the ChatThreadStore seam. */
export function chatThreadRoutes(store: ChatThreadStore, project: Project) {
  const app = new Hono();

  app.get("/", (c) => c.json(store.listThreads(project.id)));

  app.post("/", (c) => c.json(store.createOrReuseEmptyDraft(project.id), 201));

  app.get("/last-opened", (c) => {
    const thread = store.getLastOpened(project.id);
    return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
  });

  app.get("/:id", (c) => {
    const thread = store.getThread(c.req.param("id"));
    return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
  });

  app.patch("/:id", async (c) => {
    const body = await c.req.json<{ title?: string; model?: string | null }>();
    try {
      if (body.title !== undefined) {
        const thread = store.renameThread(c.req.param("id"), body.title);
        return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
      }
      const existing = store.getThread(c.req.param("id"));
      return existing ? c.json(existing) : c.json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof ChatThreadStoreError) {
        return c.json({ error: e.message }, e.status as 400);
      }
      throw e;
    }
  });

  app.post("/:id/open", (c) => {
    const thread = store.markOpened(c.req.param("id"));
    return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
  });

  app.delete("/:id", (c) => {
    const ok = store.deleteThread(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  return app;
}
