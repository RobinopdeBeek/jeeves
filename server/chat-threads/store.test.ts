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
    expect(JSON.parse(fs.readFileSync(transcriptPath, "utf8"))).toEqual({
      version: 1,
      headId: null,
      messages: [],
    });
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
    threads.saveTranscript(first.id, [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    ]);
    const second = threads.createOrReuseEmptyDraft(project.id);

    expect(second.id).not.toBe(first.id);
  });

  it("does not treat a truncated-but-branched transcript as an empty draft", () => {
    const first = threads.createOrReuseEmptyDraft(project.id);
    threads.saveTranscript(first.id, [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "kept" }],
      },
    ]);
    threads.truncateTranscript(first.id, null);
    expect(threads.loadTranscript(first.id)).toEqual([]);

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

  it("persists a per-thread model id (and clears it back to null)", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    const pinned = threads.setModel(thread.id, "composer-2.5");

    expect(pinned?.model).toBe("composer-2.5");
    expect(threads.getThread(thread.id)?.model).toBe("composer-2.5");

    const cleared = threads.setModel(thread.id, null);
    expect(cleared?.model).toBeNull();
  });

  it("rejects a blank model id", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    expect(() => threads.setModel(thread.id, "  ")).toThrow(/model/i);
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
    const onDisk = JSON.parse(
      fs.readFileSync(threads.transcriptPath(thread.id), "utf8"),
    );
    expect(onDisk.version).toBe(1);
    expect(onDisk.headId).toBe("a1");
    expect(threads.loadBranchable(thread.id).messages).toHaveLength(2);
  });

  it("migrates a legacy flat transcript array on load", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    fs.writeFileSync(
      threads.transcriptPath(thread.id),
      `${JSON.stringify(
        [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "legacy" }],
          },
        ],
        null,
        2,
      )}\n`,
    );

    expect(threads.loadTranscript(thread.id).map((m) => m.id)).toEqual(["u1"]);
    expect(threads.loadBranchable(thread.id).version).toBe(1);
  });

  it("fails closed on corrupt transcript JSON without deleting the file", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    const file = threads.transcriptPath(thread.id);
    fs.writeFileSync(file, "{not-json\n", "utf8");
    expect(() => threads.loadBranchable(thread.id)).toThrow(/corrupt/i);
    expect(fs.readFileSync(file, "utf8")).toContain("{not-json");
  });

  it("fails closed on invalid branchable shape without deleting the file", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    const file = threads.transcriptPath(thread.id);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: 1, headId: "ghost", messages: [] })}\n`,
    );
    expect(() => threads.loadBranchable(thread.id)).toThrow(/corrupt/i);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).headId).toBe("ghost");
  });

  it("truncates and switches branches while retaining siblings", () => {
    const thread = threads.createOrReuseEmptyDraft(project.id);
    threads.saveTranscript(thread.id, [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "v1" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "r1" }],
      },
    ]);

    // Edit rewind: truncate before the user message so the next send forks.
    threads.truncateTranscript(thread.id, null);
    expect(threads.loadTranscript(thread.id)).toEqual([]);

    threads.saveTranscript(thread.id, [
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "v2" }],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "r2" }],
      },
    ]);

    expect(threads.getBranches(thread.id, "u2").sort()).toEqual(["u1", "u2"]);

    threads.switchTranscriptBranch(thread.id, "u1");
    expect(threads.loadTranscript(thread.id).map((m) => m.id)).toEqual([
      "u1",
      "a1",
    ]);
  });
});
