import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../cards/store.js";
import { ChatThreadStore } from "../chat-threads/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { chatThreadRoutes } from "./chat-threads.js";

describe("chat thread routes", () => {
  let db: Db;
  let project: Project;
  let chatRoot: string;
  let store: ChatThreadStore;

  beforeEach(() => {
    db = openDb(":memory:");
    const cards = new CardStore(db);
    project = cards.ensureDefaultProject("jeeves", "/tmp/repo");
    chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-chat-routes-"));
    store = new ChatThreadStore(db, chatRoot);
  });

  afterEach(() => {
    fs.rmSync(chatRoot, { recursive: true, force: true });
  });

  it("lists, creates, opens, renames, and deletes threads", async () => {
    const app = chatThreadRoutes(store, project);

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
    const app = chatThreadRoutes(store, project);
    const first = (await (
      await app.request("http://localhost/", { method: "POST" })
    ).json()) as { id: string };
    const secondRes = await app.request("http://localhost/", { method: "POST" });
    const second = (await secondRes.json()) as { id: string };
    expect(second.id).toBe(first.id);
  });

  it("returns 404 for missing threads", async () => {
    const app = chatThreadRoutes(store, project);
    const res = await app.request("http://localhost/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
