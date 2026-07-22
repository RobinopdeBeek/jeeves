import { beforeEach, describe, expect, it } from "vitest";
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

describe("POST /:id/create-spec", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let events: EventBus;
  let sessions: ChatSessionRegistry;
  let emitted: JeevesEvent[];
  let deps: CardRouteDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    events = new EventBus();
    sessions = new ChatSessionRegistry();
    emitted = [];
    events.subscribe((e) => emitted.push(e));
    deps = {
      engine: { enqueue() {}, retry() { throw new Error("unused"); } } as unknown as CardRouteDeps["engine"],
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events,
      artifacts: {} as CardRouteDeps["artifacts"],
      sessions,
    };
  });

  function featureInGrill(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Workout streaks" });
    return store.decideKind(card.id, "feature").id;
  }

  it("hands off grill→spec, closes ACP session, and emits card.updated", async () => {
    const cardId = featureInGrill();
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: Array<{ key: string; status: string }>;
    };
    expect(body.steps.find((s) => s.key === "grill")?.status).toBe("done");
    expect(body.steps.find((s) => s.key === "spec")?.status).toBe("needs-user");

    expect(conn.displacedWith).toEqual(["grill handed off to spec"]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBeUndefined();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "card.updated",
      card: { id: cardId },
    });
  });

  it("closes ACP before freezing grill (session gone even if hand-off is observed)", async () => {
    const cardId = featureInGrill();
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);

    const closeOrder: string[] = [];
    const originalClose = sessions.close.bind(sessions);
    sessions.close = (key, reason) => {
      closeOrder.push("close");
      originalClose(key, reason);
    };
    const originalHandOff = store.handOffGrillToSpec.bind(store);
    store.handOffGrillToSpec = (id) => {
      closeOrder.push("handOff");
      return originalHandOff(id);
    };

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(closeOrder).toEqual(["close", "handOff"]);
  });

  it("succeeds with no live ACP session", async () => {
    const cardId = featureInGrill();
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(emitted).toHaveLength(1);
  });

  it("returns 409 when grill is ai-working without closing the session", async () => {
    const cardId = featureInGrill();
    store.setStepStatus(cardId, "grill", "ai-working");
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(emitted).toHaveLength(0);
    expect(conn.displacedWith).toEqual([]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBe(conn);
  });

  it("returns 404 for a missing card", async () => {
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/missing/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
