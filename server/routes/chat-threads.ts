import { Hono } from "hono";
import type { UIMessage } from "ai";
import type {
  BranchableTranscript,
  RewindOp,
} from "../../shared/branchable-transcript.js";
import {
  ChatThreadStoreError,
  type ChatThreadStore,
} from "../chat-threads/store.js";
import type { Project } from "../db/schema.js";

export interface ChatThreadRouteHooks {
  /** Evict warm ACP for a hard-deleted Chat Thread (opaque `thread:…` id). */
  onThreadDeleted?: (threadId: string) => void;
  /** Replace warm ACP when the thread's pinned model changes. */
  onThreadModelChanged?: (threadId: string, model: string | null) => void;
  /**
   * Edit/branch rewind: truncate or switch, close warm ACP, respawn so the
   * next user turn seed-onces from the rewound path.
   */
  rewindThread?: (
    threadId: string,
    op: RewindOp,
  ) => Promise<{
    messages: UIMessage[];
    branchable: BranchableTranscript;
  }>;
}

/** Thin HTTP adapter over the ChatThreadStore seam. */
export function chatThreadRoutes(
  store: ChatThreadStore,
  project: Project,
  hooks: ChatThreadRouteHooks = {},
) {
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

  /** Branch-aware transcript for edit/branch UI (active path + siblings). */
  app.get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    if (!store.getThread(id)) return c.json({ error: "not found" }, 404);
    return c.json(store.loadBranchable(id));
  });

  /**
   * Truncate at an edit point or switch to a sibling branch, then kill/respawn
   * warm ACP via `rewindThread` (required for a real rewind).
   */
  app.post("/:id/rewind", async (c) => {
    const id = c.req.param("id");
    if (!store.getThread(id)) return c.json({ error: "not found" }, 404);
    if (!hooks.rewindThread) {
      return c.json({ error: "rewind not configured" }, 500);
    }

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
      const result = await hooks.rewindThread(id, op);
      return c.json(result);
    } catch (e) {
      if (e instanceof ChatThreadStoreError) {
        return c.json({ error: e.message }, e.status as 400);
      }
      throw e;
    }
  });

  app.patch("/:id", async (c) => {
    const body = await c.req.json<{ title?: string; model?: string | null }>();
    try {
      const id = c.req.param("id");
      if (body.model !== undefined) {
        const before = store.getThread(id);
        if (!before) return c.json({ error: "not found" }, 404);
        const thread = store.setModel(id, body.model);
        if (!thread) return c.json({ error: "not found" }, 404);
        if (before.model !== thread.model) {
          hooks.onThreadModelChanged?.(id, thread.model);
        }
        return c.json(thread);
      }
      if (body.title !== undefined) {
        const thread = store.renameThread(id, body.title);
        return thread ? c.json(thread) : c.json({ error: "not found" }, 404);
      }
      const existing = store.getThread(id);
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
    const id = c.req.param("id");
    const ok = store.deleteThread(id);
    if (ok) hooks.onThreadDeleted?.(id);
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  return app;
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
