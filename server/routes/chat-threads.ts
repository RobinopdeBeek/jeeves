import { Hono } from "hono";
import fs from "node:fs";
import type {
  RewindOp,
} from "../../shared/branchable-transcript.js";
import {
  AttachmentStoreError,
  chatAttachmentsDir,
  contentTypeForAttachmentFile,
  findAttachmentFile,
  writeAttachmentBytes,
} from "../attachments/store.js";
import {
  ChatThreadStoreError,
  type ChatThreadStore,
} from "../chat-threads/store.js";
import type { Project } from "../db/schema.js";
import type { ProjectChat } from "../ws/project-chat.js";

/** Thin HTTP adapter over ChatThreadStore + ProjectChat lifecycle (AcpBridge). */
export function chatThreadRoutes(
  store: ChatThreadStore,
  project: Project,
  projectChat: ProjectChat,
) {
  const app = new Hono();

  app.get("/", (c) => {
    // Chat page load: start a spare handshake now so the first open is instant.
    projectChat.prewarm();
    return c.json(store.listThreads(project.id));
  });

  app.post("/", (c) => c.json(store.createOrReuseEmptyDraft(project.id), 201));

  app.get("/last-opened", (c) => {
    const thread = store.getLastOpened(project.id);
    return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
  });

  app.get("/:id", (c) => {
    const thread = store.getThread(c.req.param("id"));
    return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
  });

  /** Branch-aware transcript for edit/branch UI (active path + siblings). */
  app.get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    if (!store.getThread(id)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(store.loadBranchable(id));
    } catch (e) {
      return storeError(c, e);
    }
  });

  /**
   * Truncate at an edit point or switch to a sibling branch, then kill/respawn
   * warm ACP via ProjectChat.rewind (durable rewind; explicit warm outcome).
   */
  app.post("/:id/rewind", async (c) => {
    const id = c.req.param("id");
    if (!store.getThread(id)) return c.json({ error: "not found" }, 404);

    const body = await c.req.json<Record<string, unknown>>();
    let op: RewindOp;
    try {
      op = parseRewindOp(body);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        400,
      );
    }

    try {
      const result = await projectChat.rewind(id, op);
      return c.json({
        messages: result.messages,
        branchable: result.branchable,
        warm:
          result.warm.status === "open"
            ? { status: "open" as const }
            : {
                status: "failed" as const,
                error: result.warm.error,
              },
      });
    } catch (e) {
      return storeError(c, e);
    }
  });

  app.patch("/:id", async (c) => {
    const body = await c.req.json<{ title?: string; model?: string | null }>();
    try {
      const id = c.req.param("id");
      if (body.model !== undefined) {
        const thread = await projectChat.setModel(id, body.model);
        return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
      }
      if (body.title !== undefined) {
        const thread = store.renameThread(id, body.title);
        return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
      }
      const existing = store.getThread(id);
      return existing ? c.json(existing) : c.json({ error: "not found" }, 404);
    } catch (e) {
      return storeError(c, e);
    }
  });

  app.post("/:id/open", (c) => {
    const thread = store.markOpened(c.req.param("id"));
    return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
  });

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const ok = projectChat.deleteThread(id);
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /**
   * Upload a Project Chat turn attachment (multipart). Returns a pointer
   * ChatAttachment for the WS turn — bytes never go in transcript.json.
   */
  app.post("/:id/attachments", async (c) => {
    const threadId = c.req.param("id");
    if (!store.getThread(threadId)) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) {
        return c.json({ error: "file is required" }, 400);
      }
      const filename =
        typeof body.filename === "string" && body.filename
          ? body.filename
          : file.name || undefined;
      const mediaType =
        typeof body.mediaType === "string" && body.mediaType
          ? body.mediaType
          : file.type || undefined;
      const created = writeAttachmentBytes(
        { kind: "chat", chatRoot: store.root, threadId },
        {
          filename,
          mediaType,
          bytes: Buffer.from(await file.arrayBuffer()),
        },
      );
      return c.json(created, 201);
    } catch (e) {
      if (e instanceof AttachmentStoreError) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });

  /**
   * Serve a Project Chat turn attachment sidecar by id.
   * Path: data/chat/<threadId>/attachments/<attachmentId>-<safeName>
   */
  app.get("/:id/attachments/:attachmentId", (c) => {
    const threadId = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    if (!store.getThread(threadId)) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      const dir = chatAttachmentsDir(store.root, threadId);
      const abs = findAttachmentFile(dir, attachmentId);
      if (!abs || !fs.existsSync(abs)) {
        return c.json({ error: "not found" }, 404);
      }
      const body = fs.readFileSync(abs);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentTypeForAttachmentFile(abs),
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch (e) {
      if (e instanceof AttachmentStoreError) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });

  return app;
}

function storeError(
  c: { json: (body: unknown, status: 400 | 404 | 500) => Response },
  e: unknown,
) {
  if (e instanceof ChatThreadStoreError) {
    const status = e.status as 400 | 404 | 500;
    return c.json({ error: e.message }, status);
  }
  throw e;
}

function parseRewindOp(body: Record<string, unknown>): RewindOp {
  const action = body.action;
  if (action === "truncate") {
    if (body.headId !== null && typeof body.headId !== "string") {
      throw new Error("truncate requires headId: string | null");
    }
    return { action: "truncate", headId: body.headId as string | null };
  }
  if (action === "switch") {
    if (typeof body.branchId !== "string" || !body.branchId) {
      throw new Error("switch requires branchId: string");
    }
    return { action: "switch", branchId: body.branchId };
  }
  throw new Error('action must be "truncate" or "switch"');
}
