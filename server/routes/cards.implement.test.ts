import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepChatSessionId } from "../ws/chat-session.js";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus } from "../execution/events.js";
import { ChatSessionRegistry } from "../ws/session-registry.js";
import { cardRoutes, type CardRouteDeps } from "./cards.js";

describe("POST /:id/implement", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let deps: CardRouteDeps;
  let events: EventBus;
  let closeCalls: Array<{ id: string; reason: string }>;

  beforeEach(() => {
    db = openDb(":memory:");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-implement-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    store = new CardStore(db, artifacts);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    events = new EventBus();
    closeCalls = [];
    const sessions = new ChatSessionRegistry();
    const originalClose = sessions.close.bind(sessions);
    sessions.close = (id, reason) => {
      closeCalls.push({ id, reason });
      return originalClose(id, reason);
    };
    deps = {
      engine: {
        enqueue() {
          throw new Error("fan-out must not enqueue");
        },
        retry() {
          throw new Error("unused");
        },
      } as unknown as CardRouteDeps["engine"],
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events,
      artifacts,
      sessions,
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

  function featureReadyToImplement(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Workout streaks" });
    const id = store.decideKind(card.id, "feature").card.id;
    store.handOffGrillToSpec(id);
    artifacts.upsertSpec(id, 0, "# Spec\n\nBody.\n");
    store.handOffSpecToTasks(id);
    artifacts.appendTasksDraft(id, 0, {
      tasks: [
        { id: "a", title: "API", description: "", dependsOn: [] },
        { id: "b", title: "UI", description: "", dependsOn: ["a"] },
      ],
    });
    return id;
  }

  it("fans out children, emits SSE, closes Tasks chat, and rejects a second call", async () => {
    const cardId = featureReadyToImplement();
    const app = cardRoutes(store, project, deps);
    const emitted: string[] = [];
    events.subscribe((e) => {
      if (e.type === "card.updated") emitted.push(e.card.id);
    });

    const res = await app.request(`http://localhost/${cardId}/implement`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      implementProgress: { current: number; total: number };
      steps: Array<{ key: string; status: string }>;
      children: Array<{ id: string; title: string }>;
    };
    expect(body.steps.find((s) => s.key === "tasks")?.status).toBe("awaiting");
    expect(body.implementProgress).toEqual({ current: 0, total: 2 });
    expect(body.children).toHaveLength(2);
    expect(emitted).toContain(cardId);
    expect(emitted.length).toBe(3);
    expect(closeCalls).toEqual([
      {
        id: stepChatSessionId(cardId, "tasks", 0),
        reason: "tasks handed off to implement",
      },
    ]);

    const frozen = await app.request(`http://localhost/${cardId}/tasks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: [{ id: "z", title: "Nope", description: "", dependsOn: [] }],
      }),
    });
    expect(frozen.status).toBe(409);

    const again = await app.request(`http://localhost/${cardId}/implement`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
  });

  it("rejects an empty tip with 400", async () => {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Empty" });
    const id = store.decideKind(card.id, "feature").card.id;
    store.handOffGrillToSpec(id);
    store.handOffSpecToTasks(id);
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${id}/implement`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
