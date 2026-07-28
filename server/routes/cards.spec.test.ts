import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus } from "../execution/events.js";
import { ChatSessionRegistry } from "../ws/session-registry.js";
import { cardRoutes, type CardRouteDeps } from "./cards.js";

describe("PUT /:id/spec", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let deps: CardRouteDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-put-spec-"));
    artifacts = new ArtifactStore(db, artifactRoot);
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
      sessions: new ChatSessionRegistry(),
      createSpec: vi.fn(async () => {
        throw new Error("unused");
      }),
      createTasks: vi.fn(async () => {
        throw new Error("unused");
      }),
      promptsRoot: path.resolve(import.meta.dirname, "../../prompts"),
    };
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  function featureInSpec(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Workout streaks" });
    const id = store.decideKind(card.id, "feature").card.id;
    store.handOffGrillToSpec(id);
    return id;
  }

  it("upserts mutable spec markdown and returns the body", async () => {
    const cardId = featureInSpec();
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/spec`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Spec\n\nAcceptance criteria.\n" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; kind: string };
    expect(body.kind).toBe("spec");
    expect(body.content).toBe("# Spec\n\nAcceptance criteria.");

    const latest = artifacts.latest(cardId, { stepKey: "spec", round: 0, kind: "spec" });
    expect(latest).toBeTruthy();
    expect(artifacts.readBody(latest!)).toBe("# Spec\n\nAcceptance criteria.");
  });

  it("rejects upserts when the spec step is frozen", async () => {
    const cardId = featureInSpec();
    artifacts.upsertSpec(cardId, 0, "# Spec\n\nBody.\n");
    store.handOffSpecToTasks(cardId);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/spec`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Spec\n\nTampered.\n" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "spec is frozen" });
  });

  it("returns 400 when content is missing", async () => {
    const cardId = featureInSpec();
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/spec`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
