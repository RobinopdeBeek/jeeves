import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import {
  GrillSessionExtractError,
  type ExtractGrillSession,
} from "../chat/grill-session-extract.js";
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

const sampleTranscript: UIMessage[] = [
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "**Q1:** What is the scope?" }],
  },
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Add item only." }],
  },
];

describe("POST /:id/create-spec", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let events: EventBus;
  let sessions: ChatSessionRegistry;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let emitted: JeevesEvent[];
  let extractGrillSession: ReturnType<typeof vi.fn<ExtractGrillSession>>;
  let deps: CardRouteDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    project = store.ensureDefaultProject("jeeves", "C:/repo");
    events = new EventBus();
    sessions = new ChatSessionRegistry();
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-create-spec-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    emitted = [];
    events.subscribe((e) => emitted.push(e));
    extractGrillSession = vi.fn<ExtractGrillSession>(async () => {
      return "## Q1: What is the scope?\n**A:** Add item only.";
    });
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
      extractGrillSession,
      promptsRoot: path.resolve(import.meta.dirname, "../../prompts"),
    };
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  function featureInGrill(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Workout streaks" });
    return store.decideKind(card.id, "feature").card.id;
  }

  function seedTranscript(cardId: string, messages: UIMessage[] = sampleTranscript) {
    artifacts.upsertTranscript(cardId, "grill", 0, messages);
  }

  it("extracts Grill session, hands off grill→spec, closes ACP, and emits card.updated", async () => {
    const cardId = featureInGrill();
    seedTranscript(cardId);
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

    expect(extractGrillSession).toHaveBeenCalledOnce();
    const grill = artifacts.latest(cardId, {
      stepKey: "grill",
      round: 0,
      kind: "grill",
    });
    expect(grill).toBeTruthy();
    expect(artifacts.readBody(grill!)).toContain("## Q1:");

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
    seedTranscript(cardId);
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
    seedTranscript(cardId);
    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(emitted).toHaveLength(1);
  });

  it("returns 422 when transcript is empty without calling extract or closing session", async () => {
    const cardId = featureInGrill();
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "grill transcript is empty" });
    expect(extractGrillSession).not.toHaveBeenCalled();
    expect(conn.displacedWith).toEqual([]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBe(conn);
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );
  });

  it("returns 502 when extract fails without handing off or closing session", async () => {
    const cardId = featureInGrill();
    seedTranscript(cardId);
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);
    extractGrillSession.mockRejectedValueOnce(
      new GrillSessionExtractError("extract boom"),
    );

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "extract boom" });
    expect(artifacts.latest(cardId, { stepKey: "grill", round: 0, kind: "grill" })).toBeUndefined();
    expect(conn.displacedWith).toEqual([]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBe(conn);
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );
    expect(emitted).toHaveLength(0);
  });

  it("returns 409 when grill is ai-working without closing the session", async () => {
    const cardId = featureInGrill();
    seedTranscript(cardId);
    store.setStepStatus(cardId, "grill", "ai-working");
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(extractGrillSession).not.toHaveBeenCalled();
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
