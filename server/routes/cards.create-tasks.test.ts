import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepChatSessionId } from "../ws/chat-session.js";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { createCreateTasks } from "../chat/create-tasks.js";
import {
  TasksDraftSynthesisError,
  type SynthesizeTasksDraft,
} from "../chat/to-tasks-synthesis.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus, type JeevesEvent } from "../execution/events.js";
import { RunStore } from "../execution/run-store.js";
import { projectStoreExchangePath } from "../project-store.js";
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

const TASKS_EXCHANGE = {
  tasks: [
    {
      title: "Add expiry column",
      description: "Schema.",
      depends_on: [] as number[],
    },
    {
      title: "Show expiry in UI",
      description: "List.",
      depends_on: [0],
    },
  ],
};

describe("POST /:id/create-tasks", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let events: EventBus;
  let sessions: ChatSessionRegistry;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let runs: RunStore;
  let emitted: JeevesEvent[];
  let synthesizeTasksDraft: ReturnType<typeof vi.fn<SynthesizeTasksDraft>>;
  let deps: CardRouteDeps;
  let callOrder: string[];

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-create-tasks-repo-"));
    fs.mkdirSync(path.join(repoPath, ".jeeves", "exchange"), { recursive: true });
    project = store.ensureDefaultProject("jeeves", repoPath);
    events = new EventBus();
    sessions = new ChatSessionRegistry();
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-create-tasks-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    runs = new RunStore(db);
    emitted = [];
    callOrder = [];
    events.subscribe((e) => emitted.push(e));
    synthesizeTasksDraft = vi.fn<SynthesizeTasksDraft>(async (input) => {
      callOrder.push("synthesize");
      expect(input.spec).toContain("Ship it");
      const exchangeRel = projectStoreExchangePath(
        input.cardId,
        "tasks-draft.json",
      );
      const abs = path.join(repoPath, ".jeeves", exchangeRel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(TASKS_EXCHANGE));
      artifacts.harvest(
        path.join(repoPath, ".jeeves"),
        [{ exchangePath: exchangeRel, kind: "tasks-draft", stepKey: "tasks" }],
        { cardId: input.cardId, round: 0, sourceSkill: "to-draft-tasks" },
      );
    });
    const engine = {
      enqueue() {},
      retry() {
        throw new Error("unused");
      },
    } as unknown as CardRouteDeps["engine"];
    deps = {
      engine,
      runs,
      events,
      artifacts,
      sessions,
      createSpec: vi.fn(async () => {
        throw new Error("unused");
      }),
      createTasks: createCreateTasks({
        store,
        artifacts,
        sessions,
        engine,
        events,
        runs,
        synthesizeTasksDraft,
      }),
      promptsRoot: path.resolve(import.meta.dirname, "../../prompts"),
    };
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function featureInSpec(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Workout streaks" });
    const id = store.decideKind(card.id, "feature").card.id;
    store.handOffGrillToSpec(id);
    artifacts.save({
      cardId: id,
      stepKey: "grill",
      round: 0,
      kind: "grill",
      content: "## Q1: Scope?\n**A:** Streaks only.",
      sourceSkill: "grill-session",
    });
    return id;
  }

  function seedSpec(cardId: string, markdown: string) {
    artifacts.upsertSpec(cardId, 0, markdown);
  }

  it("closes Spec, synthesizes tip, advances steps, records succeeded run, emits SSE", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nShip it.\n");
    const conn = fakeConn();
    sessions.claim(stepChatSessionId(cardId, "spec", 0), conn);

    const closeOrder: string[] = [];
    const originalClose = sessions.close.bind(sessions);
    sessions.close = (id, reason) => {
      closeOrder.push("close");
      callOrder.push("close");
      originalClose(id, reason);
    };
    const originalHandOff = store.handOffSpecToTasks.bind(store);
    store.handOffSpecToTasks = (id) => {
      callOrder.push("handOff");
      return originalHandOff(id);
    };

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: Array<{ key: string; status: string }>;
      canCreateTasks: boolean;
      creatingTasks: boolean;
    };
    expect(body.steps.find((s) => s.key === "spec")?.status).toBe("done");
    expect(body.steps.find((s) => s.key === "tasks")?.status).toBe("needs-user");
    expect(body.canCreateTasks).toBe(false);
    expect(body.creatingTasks).toBe(false);

    expect(conn.displacedWith).toEqual(["closing spec for tasks synthesis"]);
    expect(sessions.get(stepChatSessionId(cardId, "spec", 0))).toBeUndefined();
    expect(() => store.assertSpecMutable(cardId)).toThrow(/frozen/i);

    const tip = artifacts.readTasksDraftTip(cardId, 0);
    expect(tip.tasks).toHaveLength(2);
    expect(tip.tasks[0]!.title).toBe("Add expiry column");

    const cardRuns = runs.listForCard(cardId);
    expect(cardRuns).toHaveLength(1);
    expect(cardRuns[0]).toMatchObject({
      stepKey: "tasks",
      skill: "to-draft-tasks",
      status: "succeeded",
    });

    expect(callOrder).toEqual(["close", "synthesize", "handOff"]);
    expect(closeOrder).toEqual(["close"]);

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(emitted[0]).toMatchObject({
      type: "card.updated",
      card: { id: cardId, creatingTasks: true },
    });
    expect(emitted[emitted.length - 1]).toMatchObject({
      type: "card.updated",
      card: { id: cardId, creatingTasks: false },
    });
  });

  it("fails closed on synthesis error: no advance, failed run, clears creatingTasks", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nShip it.\n");
    const conn = fakeConn();
    sessions.claim(stepChatSessionId(cardId, "spec", 0), conn);

    synthesizeTasksDraft.mockImplementation(async () => {
      callOrder.push("synthesize");
      throw new TasksDraftSynthesisError("zod blew up");
    });

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "zod blew up" });
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "spec")?.status).toBe(
      "needs-user",
    );
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "tasks")?.status).toBe(
      "pending",
    );
    expect(store.getCard(cardId)?.creatingTasks).toBe(false);
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(0);
    expect(runs.listForCard(cardId)[0]).toMatchObject({
      status: "failed",
      error: "zod blew up",
    });
    // Spec chat was closed before synthesis; session stays closed on failure.
    expect(conn.displacedWith).toEqual(["closing spec for tasks synthesis"]);
    expect(emitted[0]).toMatchObject({
      type: "card.updated",
      card: { creatingTasks: true },
    });
    expect(emitted[emitted.length - 1]).toMatchObject({
      type: "card.updated",
      card: { creatingTasks: false },
    });
  });

  it("returns 422 when spec body is empty without closing ACP", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "   \n\n  ");
    const conn = fakeConn();
    sessions.claim(stepChatSessionId(cardId, "spec", 0), conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "spec body is empty" });
    expect(conn.displacedWith).toEqual([]);
    expect(synthesizeTasksDraft).not.toHaveBeenCalled();
    expect(runs.listForCard(cardId)).toHaveLength(0);
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

  it("returns 409 when synthesis is already in progress", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nShip it.\n");
    store.setCreatingTasks(cardId, true);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "tasks synthesis already in progress",
    });
    expect(synthesizeTasksDraft).not.toHaveBeenCalled();
  });

  it("returns 409 when spec is ai-working", async () => {
    const cardId = featureInSpec();
    seedSpec(cardId, "# Spec\n\nShip it.\n");
    store.setStepStatus(cardId, "spec", "ai-working");

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(synthesizeTasksDraft).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing card", async () => {
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/missing/create-tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
