import { Hono } from "hono";
import type {
  RewindOp,
} from "../../shared/branchable-transcript.js";
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
