import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardAttachmentStore } from "../attachments/card-library.js";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus } from "../execution/events.js";
import { ChatSessionRegistry } from "../ws/session-registry.js";
import { cardRoutes, type CardRouteDeps } from "./cards.js";

const NOTES_BODY = "# library note\n";

describe("card attachment library routes", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let artifactRoot: string;
  let artifacts: ArtifactStore;
  let cardAttachments: CardAttachmentStore;
  let deps: CardRouteDeps;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-att-routes-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    cardAttachments = new CardAttachmentStore(db, artifactRoot);
    deps = {
      engine: {
        enqueue() {},
        retry() {
          throw new Error("unused");
        },
      } as unknown as CardRouteDeps["engine"],
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events: new EventBus(),
      artifacts,
      cardAttachments,
      sessions: new ChatSessionRegistry(),
      spawn: () => {
        throw new Error("unused");
      },
      createSpec: async () => {
        throw new Error("unused");
      },
      createTasks: async () => {
        throw new Error("unused");
      },
      promptsRoot: path.resolve(import.meta.dirname, "../../prompts"),
    };
    cardId = store.createCard(project.id).id;
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  function app() {
    return cardRoutes(store, project, deps);
  }

  it("lists empty, adds via JSON, patches instruction, serves bytes, deletes", async () => {
    const routes = app();

    const empty = await routes.request(
      `http://localhost/${cardId}/attachments`,
    );
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const createdRes = await routes.request(
      `http://localhost/${cardId}/attachments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "notes.md",
          mediaType: "text/markdown",
          instruction: "Read first",
          originStep: "info",
          data: Buffer.from(NOTES_BODY, "utf8").toString("base64"),
        }),
      },
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as {
      id: string;
      filename: string;
      instruction: string;
      originStep: string;
    };
    expect(created.filename).toBe("notes.md");
    expect(created.instruction).toBe("Read first");
    expect(created.originStep).toBe("info");

    const listed = await routes.request(
      `http://localhost/${cardId}/attachments`,
    );
    expect(await listed.json()).toMatchObject([
      { id: created.id, filename: "notes.md" },
    ]);

    const patched = await routes.request(
      `http://localhost/${cardId}/attachments/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Updated note" }),
      },
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      id: created.id,
      instruction: "Updated note",
    });

    const bytes = await routes.request(
      `http://localhost/${cardId}/attachments/${created.id}`,
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("Content-Type")).toMatch(/markdown|plain/);
    expect(Buffer.from(await bytes.arrayBuffer()).toString("utf8")).toBe(
      NOTES_BODY,
    );

    const del = await routes.request(
      `http://localhost/${cardId}/attachments/${created.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const after = await routes.request(
      `http://localhost/${cardId}/attachments`,
    );
    expect(await after.json()).toEqual([]);
  });

  it("adds via multipart FormData", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([NOTES_BODY], "from-form.md", { type: "text/markdown" }),
    );
    form.append("originStep", "info");
    form.append("instruction", "form upload");

    const res = await app().request(`http://localhost/${cardId}/attachments`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      filename: string;
      instruction: string;
      originStep: string;
    };
    expect(body.filename).toBe("from-form.md");
    expect(body.instruction).toBe("form upload");
    expect(body.originStep).toBe("info");
  });

  it("returns 404 for unknown card or attachment", async () => {
    const routes = app();
    expect(
      (await routes.request(`http://localhost/missing/attachments`)).status,
    ).toBe(404);

    const res = await routes.request(
      `http://localhost/${cardId}/attachments/nope`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "x" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("card hard-delete removes library folder and SQL rows", async () => {
    const created = cardAttachments.add({
      cardId,
      filename: "keep.md",
      bytes: Buffer.from("x"),
    });
    const libDir = path.join(artifactRoot, "cards", cardId, "attachments");
    expect(fs.existsSync(libDir)).toBe(true);

    const del = await app().request(`http://localhost/${cardId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(artifactRoot, "cards", cardId))).toBe(false);
    expect(cardAttachments.list(cardId)).toEqual([]);
    expect(cardAttachments.get(cardId, created.id)).toBeNull();
  });
});
