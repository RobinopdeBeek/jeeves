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

describe("tasks-draft routes", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let deps: CardRouteDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-tasks-draft-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    store = new CardStore(db, artifacts);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
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

  function featureInTasks(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Workout streaks" });
    const id = store.decideKind(card.id, "feature").card.id;
    store.handOffGrillToSpec(id);
    artifacts.upsertSpec(id, 0, "# Spec\n\nBody.\n");
    store.handOffSpecToTasks(id);
    return id;
  }

  it("returns an empty tip when no versions exist", async () => {
    const cardId = featureInTasks();
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tasks: [], versionCount: 0 });
  });

  it("Save appends a new tip version", async () => {
    const cardId = featureInTasks();
    const app = cardRoutes(store, project, deps);
    const body = {
      tasks: [{ id: "a", title: "API", description: "d", dependsOn: [] }],
    };
    const res = await app.request(`http://localhost/${cardId}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...body, versionCount: 1 });
    expect(artifacts.list(cardId).filter((a) => a.kind === "tasks-draft")).toHaveLength(1);

    const updated = {
      tasks: [
        { id: "a", title: "API", description: "d", dependsOn: [] },
        { id: "b", title: "UI", description: "", dependsOn: ["a"] },
      ],
    };
    const res2 = await app.request(`http://localhost/${cardId}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ...updated, versionCount: 2 });
    expect(artifacts.list(cardId).filter((a) => a.kind === "tasks-draft")).toHaveLength(2);
  });

  it("rejects Save with empty titles or cycles", async () => {
    const cardId = featureInTasks();
    const app = cardRoutes(store, project, deps);
    const emptyTitle = await app.request(`http://localhost/${cardId}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [{ id: "a", title: "", description: "", dependsOn: [] }],
      }),
    });
    expect(emptyTitle.status).toBe(400);

    const cycle = await app.request(`http://localhost/${cardId}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { id: "a", title: "A", description: "", dependsOn: ["b"] },
          { id: "b", title: "B", description: "", dependsOn: ["a"] },
        ],
      }),
    });
    expect(cycle.status).toBe(400);
  });

  it("Delete appends a version with edges cleaned", async () => {
    const cardId = featureInTasks();
    artifacts.appendTasksDraft(cardId, 0, {
      tasks: [
        { id: "a", title: "A", description: "", dependsOn: [] },
        { id: "b", title: "B", description: "", dependsOn: ["a"] },
      ],
    });
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/tasks/a`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tasks: [{ id: "b", title: "B", description: "", dependsOn: [] }],
      versionCount: 2,
    });
    expect(artifacts.list(cardId).filter((a) => a.kind === "tasks-draft")).toHaveLength(2);
  });

  it("undo appends a copy of the previous tip", async () => {
    const cardId = featureInTasks();
    const v1 = {
      tasks: [{ id: "a", title: "A", description: "", dependsOn: [] }],
    };
    const v2 = {
      tasks: [
        { id: "a", title: "A", description: "", dependsOn: [] },
        { id: "b", title: "B", description: "", dependsOn: [] },
      ],
    };
    artifacts.appendTasksDraft(cardId, 0, v1);
    artifacts.appendTasksDraft(cardId, 0, v2);
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/tasks/undo`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...v1, versionCount: 3 });
    expect(artifacts.list(cardId).filter((a) => a.kind === "tasks-draft")).toHaveLength(3);
  });

  it("undo returns 409 when there is no previous tip", async () => {
    const cardId = featureInTasks();
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/tasks/undo`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("rejects mutations when tasks is frozen", async () => {
    const cardId = featureInTasks();
    store.setStepStatus(cardId, "tasks", "done");
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [{ id: "a", title: "A", description: "", dependsOn: [] }],
      }),
    });
    expect(res.status).toBe(409);
  });
});
