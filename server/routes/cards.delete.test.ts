import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus } from "../execution/events.js";
import { ChatSessionRegistry } from "../ws/session-registry.js";
import { cardRoutes, type CardRouteDeps } from "./cards.js";

describe("DELETE /:id", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let artifactRoot: string;
  let artifacts: ArtifactStore;
  let deps: CardRouteDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-artifacts-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    deps = {
      engine: { enqueue() {}, retry() { throw new Error("unused"); } } as unknown as CardRouteDeps["engine"],
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events: new EventBus(),
      artifacts,
      sessions: new ChatSessionRegistry(),
    };
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("hard-deletes the card and removes its artifact folder", async () => {
    const card = store.createCard(project.id);
    artifacts.save({
      cardId: card.id,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      content: "# Plan",
      sourceSkill: "slice-3-tracer",
    });
    const cardDir = path.join(artifactRoot, "cards", card.id);
    expect(fs.existsSync(cardDir)).toBe(true);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${card.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.getCard(card.id)).toBeUndefined();
    expect(fs.existsSync(cardDir)).toBe(false);
  });

  it("returns 404 for a missing card without touching other folders", async () => {
    const other = store.createCard(project.id);
    artifacts.save({
      cardId: other.id,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      content: "# Plan",
      sourceSkill: "slice-3-tracer",
    });
    const otherDir = path.join(artifactRoot, "cards", other.id);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/missing`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});
