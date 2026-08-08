import { Hono } from "hono";
import {
  CardDiffError,
  type CardDiff,
} from "../execution/card-diff.js";
import { CardStoreError, type CardStore } from "../cards/store.js";

/**
 * Live three-dot diff for a card branch vs upstream.
 * GET / → file list + stats + resolved SHAs
 * GET /file?path= → unified patch for one path
 */
export function cardDiffRoutes(store: CardStore, diff: CardDiff) {
  const app = new Hono();

  app.get("/", async (c) => {
    const cardId = c.req.param("id");
    try {
      const range = resolveDiffRange(store, cardId);
      const summary = await diff.listThreeDot(range.upstreamRef, range.cardBranch);
      return c.json(summary);
    } catch (e) {
      return diffError(c, e);
    }
  });

  app.get("/file", async (c) => {
    const cardId = c.req.param("id");
    const filePath = c.req.query("path");
    if (typeof filePath !== "string" || !filePath) {
      return c.json({ error: "path is required" }, 400);
    }
    try {
      const range = resolveDiffRange(store, cardId);
      const patch = await diff.filePatch(
        range.upstreamRef,
        range.cardBranch,
        filePath,
      );
      return c.json({ path: filePath, patch });
    } catch (e) {
      return diffError(c, e);
    }
  });

  return app;
}

function resolveDiffRange(store: CardStore, cardId: string) {
  const card = store.getCard(cardId);
  if (!card) throw new CardStoreError(404, "card not found");
  if (!card.branch) throw new CardStoreError(409, "card branch not recorded");
  const upstreamRef = store.getUpstreamRef(cardId);
  return { upstreamRef, cardBranch: card.branch };
}

function diffError(c: { json: (body: unknown, status: 400 | 404 | 409) => Response }, e: unknown) {
  if (e instanceof CardStoreError) {
    return c.json({ error: e.message }, e.status as 400 | 404 | 409);
  }
  if (e instanceof CardDiffError) {
    return c.json({ error: e.message }, e.status as 400 | 404 | 409);
  }
  throw e;
}
