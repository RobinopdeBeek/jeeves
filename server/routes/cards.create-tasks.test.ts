import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus, type JeevesEvent } from "../execution/events.js";
import {
  ChatSessionRegistry,
  type DisplaceableConnection,
} from "../ws/session-registry.js";
import { cardRoutes, type CardRouteDeps } from "./cards.js";

function fakeConn(): DisplaceableConnection & { displacedWith: string[] } {
  const displacedWith: string[] = [];
  return {
    displacedWith,
    displace(reason: string) {
      displacedWith.push(reason);
    },
  };
}

describe("POST /:id/create-tasks", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let events: EventBus;
  let sessions: ChatSessionRegistry;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let emitted: JeevesEvent[];
  let deps: CardRouteDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    events = new EventBus();
    sessions = new ChatSessionRegistry();
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-create-tasks-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    emitted = [];
    events.subscribe((e) => emitted.push(e));
    deps = {
      engine: {
        enqueue() {},
        retry() {
          throw new Error("unused");
        },
      } as unknown as CardRouteDeps["engine"],
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events,
      artifacts,
      sessions,
      extractGrillSession: vi.fn(async () => "## unused"),
      synthesizeSpec: vi.fn(async () => {}),
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

  function seedSpec(cardId: string, markdown: string) {
    artifacts.upsertSpec(cardId, 0, markdown);
  }

  it("freezes spec, advances to tasks, closes ACP, and emits card.updated", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nShip it.\n");
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "spec", round: 0 }, conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: Array<{ key: string; status: string }>;
      canCreateTasks: boolean;
    };
    expect(body.steps.find((s) => s.key === "spec")?.status).toBe("done");
    expect(body.steps.find((s) => s.key === "tasks")?.status).toBe("needs-user");
    expect(body.canCreateTasks).toBe(false);

    expect(conn.displacedWith).toEqual(["spec handed off to tasks"]);
    expect(sessions.get({ cardId, stepKey: "spec", round: 0 })).toBeUndefined();
    expect(() => store.assertSpecMutable(cardId)).toThrow(/frozen/i);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "card.updated",
      card: { id: cardId },
    });
  });

  it("closes ACP before freezing spec", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nBody.\n");
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "spec", round: 0 }, conn);

    const closeOrder: string[] = [];
    const originalClose = sessions.close.bind(sessions);
    sessions.close = (key, reason) => {
      closeOrder.push("close");
      originalClose(key, reason);
    };
    const originalHandOff = store.handOffSpecToTasks.bind(store);
    store.handOffSpecToTasks = (id) => {
      closeOrder.push("handOff");
      return originalHandOff(id);
    };

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(closeOrder).toEqual(["close", "handOff"]);
  });

  it("returns 422 when spec body is empty", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "   \n\n  ");
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "spec", round: 0 }, conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "spec body is empty" });
    expect(conn.displacedWith).toEqual([]);
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "spec")?.status).toBe(
      "needs-user",
    );
    expect(emitted).toHaveLength(0);
  });

  it("returns 422 when there is no spec artifact", async () => {
    const cardId = featureInSpec();
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "spec body is empty" });
    expect(emitted).toHaveLength(0);
  });

  it("returns 409 when hand-off is not allowed", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nBody.\n");
    store.handOffSpecToTasks(cardId);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(emitted).toHaveLength(0);
  });

  it("returns 404 for a missing card", async () => {
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/missing/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
