import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { ChatThreadStore } from "./store.js";

describe("ChatThreadStore", () => {
  let db: Db;
  let project: Project;
  let chatRoot: string;
  let threads: ChatThreadStore;

  beforeEach(() => {
    db = openDb(":memory:");
    const cards = new CardStore(db);
    project = cards.ensureDefaultProject("jeeves", "/tmp/repo");
    chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-chat-"));
    threads = new ChatThreadStore(db, chatRoot);
  });

  afterEach(() => {
    fs.rmSync(chatRoot, { recursive: true, force: true });
  });

  it("creates a Chat Thread row and an empty transcript file", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);

    expect(thread.projectId).toBe(project.id);
    expect(thread.title).toBe("New Chat");
    expect(thread.model).toBeNull();
    expect(thread.lastOpenedAt).toBeInstanceOf(Date);

    const transcriptPath = path.join(chatRoot, thread.id, "transcript.json");
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(transcriptPath, "utf8"))).toEqual([]);
  });

  it("reuses an existing empty draft instead of stacking another", () => {
    const first = threads.createOrReuseEmptyDraft(project.id);
    const second = threads.createOrReuseEmptyDraft(project.id);

    expect(second.id).toBe(first.id);
    expect(threads.listThreads(project.id)).toHaveLength(1);
  });

  it("creates a new thread when the empty draft was renamed", () => {
    const first = threads.createOrReuseEmptyDraft(project.id);
    threads.renameThread(first.id, "Notes");
    const second = threads.createOrReuseEmptyDraft(project.id);

    expect(second.id).not.toBe(first.id);
    expect(threads.listThreads(project.id)).toHaveLength(2);
  });

  it("creates a new thread when the draft transcript is no longer empty", () => {
    const first = threads.createOrReuseEmptyDraft(project.id);
    fs.writeFileSync(
      path.join(chatRoot, first.id, "transcript.json"),
      `${JSON.stringify([{ id: "m1", role: "user", parts: [] }], null, 2)}\n`,
    );
    const second = threads.createOrReuseEmptyDraft(project.id);

    expect(second.id).not.toBe(first.id);
  });

  it("lists threads with most recently opened first", () => {
    const a = threads.createOrReuseEmptyDraft(project.id);
    threads.renameThread(a.id, "First");
    const b = threads.createOrReuseEmptyDraft(project.id);
    threads.markOpened(a.id);

    const listed = threads.listThreads(project.id);
    expect(listed.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("renames a thread title", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    const renamed = threads.renameThread(thread.id, "Refactor plan");

    expect(renamed?.title).toBe("Refactor plan");
    expect(threads.getThread(thread.id)?.title).toBe("Refactor plan");
  });

  it("returns the last-opened thread", () => {
    const a = threads.createOrReuseEmptyDraft(project.id);
    threads.renameThread(a.id, "First");
    const b = threads.createOrReuseEmptyDraft(project.id);
    threads.markOpened(a.id);

    expect(threads.getLastOpened(project.id)?.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  it("hard-deletes the index row and on-disk transcript folder", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    const folder = path.join(chatRoot, thread.id);
    expect(fs.existsSync(folder)).toBe(true);

    expect(threads.deleteThread(thread.id)).toBe(true);
    expect(threads.getThread(thread.id)).toBeUndefined();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("loads and saves a UIMessage transcript for live Project Chat", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    expect(threads.loadTranscript(thread.id)).toEqual([]);

    const messages = [
      {
        id: "u1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "What does the board do?" }],
      },
      {
        id: "a1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "It tracks cards." }],
      },
    ];
    threads.saveTranscript(thread.id, messages);

    expect(threads.loadTranscript(thread.id)).toEqual(messages);
    expect(JSON.parse(fs.readFileSync(threads.transcriptPath(thread.id), "utf8"))).toEqual(
      messages,
    );
  });
});
