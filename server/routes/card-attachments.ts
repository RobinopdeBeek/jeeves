import { Hono } from "hono";
import fs from "node:fs";
import {
  CardAttachmentStore,
  CardAttachmentStoreError,
} from "../attachments/card-library.js";
import type { CardStore } from "../cards/store.js";
import { isStepKey, type StepKey } from "../pipelines.js";

const DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]+)$/i;

/**
 * Card attachment library REST — list / add / update-instruction / delete / bytes.
 * Mounted at `/api/cards/:id/attachments`.
 */
export function cardAttachmentRoutes(
  cards: CardStore,
  attachments: CardAttachmentStore,
) {
  const app = new Hono();

  app.get("/", (c) => {
    const cardId = c.req.param("id");
    if (!cards.getCard(cardId)) return c.json({ error: "not found" }, 404);
    return c.json(attachments.list(cardId));
  });

  app.post("/", async (c) => {
    const cardId = c.req.param("id");
    if (!cards.getCard(cardId)) return c.json({ error: "not found" }, 404);
    try {
      const contentType = c.req.header("content-type") ?? "";
      let filename: string | undefined;
      let mediaType: string | undefined;
      let instruction: string | undefined;
      let originStep: StepKey | undefined;
      let bytes: Buffer;

      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          return c.json({ error: "file is required" }, 400);
        }
        filename =
          typeof body.filename === "string" && body.filename
            ? body.filename
            : file.name || undefined;
        mediaType =
          typeof body.mediaType === "string" && body.mediaType
            ? body.mediaType
            : file.type || undefined;
        instruction =
          typeof body.instruction === "string" ? body.instruction : undefined;
        if (typeof body.originStep === "string" && isStepKey(body.originStep)) {
          originStep = body.originStep;
        }
        bytes = Buffer.from(await file.arrayBuffer());
      } else {
        const body = await c.req.json<{
          filename?: string;
          mediaType?: string;
          instruction?: string;
          originStep?: string;
          dataUrl?: string;
          data?: string;
        }>();
        filename = body.filename;
        mediaType = body.mediaType;
        instruction = body.instruction;
        if (body.originStep !== undefined) {
          if (!isStepKey(body.originStep)) {
            return c.json({ error: "invalid origin step" }, 400);
          }
          originStep = body.originStep;
        }
        if (typeof body.dataUrl === "string") {
          const match = DATA_URL_RE.exec(body.dataUrl.trim());
          if (!match) {
            return c.json({ error: "dataUrl must be a base64 data URL" }, 400);
          }
          mediaType = mediaType || match[1]!.toLowerCase();
          bytes = Buffer.from(match[2]!, "base64");
        } else if (typeof body.data === "string") {
          bytes = Buffer.from(body.data, "base64");
        } else {
          return c.json({ error: "dataUrl or data (base64) is required" }, 400);
        }
      }

      const created = attachments.add({
        cardId,
        filename,
        mediaType,
        bytes,
        instruction,
        originStep,
      });
      return c.json(created, 201);
    } catch (e) {
      return storeError(c, e);
    }
  });

  app.patch("/:attachmentId", async (c) => {
    const cardId = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    if (!cards.getCard(cardId)) return c.json({ error: "not found" }, 404);
    try {
      const body = await c.req.json<{ instruction?: unknown }>();
      if (typeof body.instruction !== "string") {
        return c.json({ error: "instruction must be a string" }, 400);
      }
      const updated = attachments.updateInstruction(
        cardId,
        attachmentId,
        body.instruction,
      );
      return updated
        ? c.json(updated)
        : c.json({ error: "not found" }, 404);
    } catch (e) {
      return storeError(c, e);
    }
  });

  app.delete("/:attachmentId", (c) => {
    const cardId = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    if (!cards.getCard(cardId)) return c.json({ error: "not found" }, 404);
    try {
      const ok = attachments.delete(cardId, attachmentId);
      return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
    } catch (e) {
      return storeError(c, e);
    }
  });

  app.get("/:attachmentId", (c) => {
    const cardId = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    if (!cards.getCard(cardId)) return c.json({ error: "not found" }, 404);
    try {
      const abs = attachments.absolutePath(cardId, attachmentId);
      if (!abs) return c.json({ error: "not found" }, 404);
      const body = fs.readFileSync(abs);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": attachments.contentType(cardId, attachmentId),
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch (e) {
      return storeError(c, e);
    }
  });

  return app;
}

function storeError(
  c: { json: (body: unknown, status: 400 | 404 | 500) => Response },
  e: unknown,
): Response {
  if (e instanceof CardAttachmentStoreError) {
    return c.json(
      { error: e.message },
      e.status as 400 | 404 | 500,
    );
  }
  throw e;
}
