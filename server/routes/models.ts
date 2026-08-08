import { Hono } from "hono";
import {
  ListModelsError,
  listAgentModels,
  type AgentModel,
} from "../models/list-models.js";

/** GET /api/models — model catalog from the ACP handshake config options. */
export function modelRoutes(
  listModels: () => Promise<AgentModel[]> = () => listAgentModels(),
) {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      const models = await listModels();
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
