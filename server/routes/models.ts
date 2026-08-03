import { Hono } from "hono";
import {
  ListModelsError,
  listAgentModels,
  type RunAgentModels,
} from "../models/list-models.js";

/** GET /api/models — Cursor Agent CLI model catalog for Project Chat. */
export function modelRoutes(run?: RunAgentModels) {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      const models = await listAgentModels(run);
      return c.json({ models });
    } catch (e) {
      if (e instanceof ListModelsError) {
        return c.json({ error: e.message }, 502);
      }
      throw e;
    }
  });

  return app;
}
