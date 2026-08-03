import { desc, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import { chatThreads, type ChatThread } from "../db/schema.js";

export class ChatThreadStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatThreadStoreError";
  }
}

/** Default title for a fresh / empty draft Chat Thread. */
export const EMPTY_DRAFT_TITLE = "New Chat";

/**
 * ChatThreadStore — project-scoped Chat Thread index + transcript files.
 * Routes and the client are thin adapters over this seam (ADR 0015).
 */
export class ChatThreadStore {
  constructor(
    private readonly db: Db,
    private readonly chatRoot: string,
  ) {}

  /** Board-style list: most recently opened first, then newest created. */
  listThreads(projectId: string): ChatThread[] {
    return this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.projectId, projectId))
      .orderBy(desc(chatThreads.lastOpenedAt), desc(chatThreads.createdAt))
      .all();
  }

  getThread(id: string): ChatThread | undefined {
    return this.db.select().from(chatThreads).where(eq(chatThreads.id, id)).get();
  }

  /**
   * New Thread: create a row + empty transcript, or reuse an existing empty
   * draft so the rail does not stack many "New Chat" rows. Marks opened.
   */
  createOrReuseEmptyDraft(projectId: string): ChatThread {
    const existing = this.findEmptyDraft(projectId);
    if (existing) {
      return this.markOpened(existing.id)!;
    }
    return this.insertThread(projectId);
  }

  renameThread(id: string, title: string): ChatThread | undefined {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new ChatThreadStoreError(400, "title is required");
    }
    const existing = this.getThread(id);
    if (!existing) return undefined;
    const now = new Date();
    this.db
      .update(chatThreads)
      .set({ title: trimmed, updatedAt: now })
      .where(eq(chatThreads.id, id))
      .run();
    return this.getThread(id);
  }

  /** Remember this thread as last-opened for bare `/chat` restore. */
  markOpened(id: string): ChatThread | undefined {
    const existing = this.getThread(id);
    if (!existing) return undefined;
    const latest = this.getLastOpened(existing.projectId);
    const floor = latest?.lastOpenedAt?.getTime() ?? 0;
    const nowMs = Math.max(Date.now(), floor + 1);
    const now = new Date(nowMs);
    this.db
      .update(chatThreads)
      .set({ lastOpenedAt: now, updatedAt: now })
      .where(eq(chatThreads.id, id))
      .run();
    return this.getThread(id);
  }

  getLastOpened(projectId: string): ChatThread | undefined {
    return this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.projectId, projectId))
      .orderBy(desc(chatThreads.lastOpenedAt), desc(chatThreads.createdAt))
      .all()
      .find((t) => t.lastOpenedAt != null);
  }

  /**
   * Hard delete: drop the index row and the on-disk transcript folder.
   * Warm ACP eviction is a later slice (#37).
   */
  deleteThread(id: string): boolean {
    const existing = this.getThread(id);
    if (!existing) return false;
    this.db.delete(chatThreads).where(eq(chatThreads.id, id)).run();
    fs.rmSync(this.threadDir(id), { recursive: true, force: true });
    return true;
  }

  /** Absolute path to a thread's transcript.json (may be empty until live chat). */
  transcriptPath(threadId: string): string {
    return path.join(this.threadDir(threadId), "transcript.json");
  }

  private insertThread(projectId: string): ChatThread {
    const now = new Date();
    const thread: ChatThread = {
      id: nanoid(10),
      projectId,
      title: EMPTY_DRAFT_TITLE,
      model: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };
    this.db.insert(chatThreads).values(thread).run();
    this.ensureEmptyTranscript(thread.id);
    return thread;
  }

  private findEmptyDraft(projectId: string): ChatThread | undefined {
    const candidates = this.listThreads(projectId);
    return candidates.find(
      (t) => t.title === EMPTY_DRAFT_TITLE && this.isEmptyTranscript(t.id),
    );
  }

  private isEmptyTranscript(threadId: string): boolean {
    const file = this.transcriptPath(threadId);
    if (!fs.existsSync(file)) return true;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) && parsed.length === 0;
    } catch {
      return false;
    }
  }

  private ensureEmptyTranscript(threadId: string): void {
    const dir = this.threadDir(threadId);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.transcriptPath(threadId);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `${JSON.stringify([], null, 2)}\n`, "utf8");
    }
  }

  private threadDir(threadId: string): string {
    return path.join(this.chatRoot, threadId);
  }
}
