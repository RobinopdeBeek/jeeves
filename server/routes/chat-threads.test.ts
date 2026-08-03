import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../cards/store.js";
import { ChatThreadStore } from "../chat-threads/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { MockAcpProcess } from "../ws/mock-acp-process.js";
import { ProjectChat } from "../ws/project-chat.js";
import { ChatSessionRegistry } from "../ws/session-registry.js";
import { chatThreadRoutes } from "./chat-threads.js";

describe("chat thread routes", () => {
  let db: Db;
  let project: Project;
  let chatRoot: string;
  let store: ChatThreadStore;
  let sessions: ChatSessionRegistry;
  let projectChat: ProjectChat;
  let spawnCount: number;

  beforeEach(() => {
    db = openDb(":memory:");
    const cards = new CardStore(db);
    project = cards.ensureDefaultProject("jeeves", "/tmp/repo");
    chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-chat-routes-"));
    store = new ChatThreadStore(db, chatRoot);
    sessions = new ChatSessionRegistry();
    spawnCount = 0;
    projectChat = new ProjectChat({
      threads: store,
      sessions,
      cwd: "/tmp/repo",
      spawn: () => {
        spawnCount += 1;
        const p = new MockAcpProcess();
        p.autoHandshake(`sess-route-${spawnCount}`);
        return p;
      },
    });
  });

  afterEach(() => {
    fs.rmSync(chatRoot, { recursive: true, force: true });
  });

  it("lists, creates, opens, renames, and deletes threads", async () => {
    const app = chatThreadRoutes(store, project, projectChat);

    const createRes = await app.request("http://localhost/", { method: "POST" });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; title: string };
    expect(created.title).toBe("New Chat");

    const listRes = await app.request("http://localhost/");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([
      expect.objectContaining({ id: created.id }),
    ]);

    const renameRes = await app.request(`http://localhost/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Spike notes" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(renameRes.status).toBe(200);
    expect(await renameRes.json()).toEqual(
      expect.objectContaining({ id: created.id, title: "Spike notes" }),
    );

    const openRes = await app.request(`http://localhost/${created.id}/open`, {
      method: "POST",
    });
    expect(openRes.status).toBe(200);

    const lastRes = await app.request("http://localhost/last-opened");
    expect(lastRes.status).toBe(200);
    expect(await lastRes.json()).toEqual(
      expect.objectContaining({ id: created.id }),
    );

    const delRes = await app.request(`http://localhost/${created.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });
    expect(fs.existsSync(path.join(chatRoot, created.id))).toBe(false);
  });

  it("POST reuses an empty draft", async () => {
    const app = chatThreadRoutes(store, project, projectChat);
    const first = (await (
      await app.request("http://localhost/", { method: "POST" })
    ).json()) as { id: string };
    const secondRes = await app.request("http://localhost/", { method: "POST" });
    const second = (await secondRes.json()) as { id: string };
    expect(second.id).toBe(first.id);
  });

  it("returns 404 for missing threads", async () => {
    const app = chatThreadRoutes(store, project, projectChat);
    const res = await app.request("http://localhost/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("PATCHes model via ProjectChat lifecycle", async () => {
    const app = chatThreadRoutes(store, project, projectChat);
    const created = (await (
      await app.request("http://localhost/", { method: "POST" })
    ).json()) as { id: string };

    const res = await app.request(`http://localhost/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ model: "composer-2.5" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ id: created.id, model: "composer-2.5" }),
    );

    const clearRes = await app.request(`http://localhost/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ model: null }),
      headers: { "Content-Type": "application/json" },
    });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual(
      expect.objectContaining({ model: null }),
    );
  });

  it("GETs the branch-aware transcript and POSTs rewind with warm outcome", async () => {
    const app = chatThreadRoutes(store, project, projectChat);
    const created = (await (
      await app.request("http://localhost/", { method: "POST" })
    ).json()) as { id: string };

    store.saveTranscript(created.id, [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
      },
    ]);

    const transcriptRes = await app.request(
      `http://localhost/${created.id}/transcript`,
    );
    expect(transcriptRes.status).toBe(200);
    const branchable = (await transcriptRes.json()) as {
      version: number;
      headId: string;
      messages: unknown[];
    };
    expect(branchable.version).toBe(1);
    expect(branchable.headId).toBe("a1");
    expect(branchable.messages).toHaveLength(2);

    const rewindRes = await app.request(
      `http://localhost/${created.id}/rewind`,
      {
        method: "POST",
        body: JSON.stringify({ action: "truncate", headId: "u1" }),
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(rewindRes.status).toBe(200);
    const body = (await rewindRes.json()) as {
      messages: Array<{ id: string }>;
      branchable: { headId: string };
      warm: { status: string };
    };
    expect(body.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(body.branchable.headId).toBe("u1");
    expect(body.warm.status).toBe("open");
    expect(spawnCount).toBe(1);
  });

  it("rejects malformed rewind bodies", async () => {
    const app = chatThreadRoutes(store, project, projectChat);
    const created = (await (
      await app.request("http://localhost/", { method: "POST" })
    ).json()) as { id: string };

    const res = await app.request(`http://localhost/${created.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ action: "nope" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});
