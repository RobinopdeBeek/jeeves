import { Hono } from "hono";
import type { CardStore } from "../cards/store.js";
import type { Project } from "../db/schema.js";

/** Thin HTTP adapter over the CardStore seam. */
export function cardRoutes(store: CardStore, project: Project) {
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

  app.delete("/:id", (c) => {
    const deleted = store.deleteCard(c.req.param("id"));
    return deleted
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404);
  });

  return app;
}
