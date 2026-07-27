import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { createCreateSpec } from "../chat/create-spec.js";
import {
  GrillSessionExtractError,
  type ExtractGrillSession,
} from "../chat/grill-session-extract.js";
import {
  SpecSynthesisError,
  type SynthesizeSpec,
} from "../chat/to-spec-synthesis.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { EventBus, type JeevesEvent } from "../execution/events.js";
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

const GRILL_SESSION = "## Q1: What is the scope?\n**A:** Add item only.";
const SPEC_MARKDOWN = "# Spec\n\n## Problem Statement\nAdd pantry items.\n";

describe("POST /:id/create-spec", () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let events: EventBus;
  let sessions: ChatSessionRegistry;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let emitted: JeevesEvent[];
  let extractGrillSession: ReturnType<typeof vi.fn<ExtractGrillSession>>;
  let synthesizeSpec: ReturnType<typeof vi.fn<SynthesizeSpec>>;
  let deps: CardRouteDeps;
  let callOrder: string[];

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-create-spec-repo-"));
    fs.mkdirSync(path.join(repoPath, ".jeeves", "exchange"), { recursive: true });
    project = store.ensureDefaultProject("jeeves", repoPath);
    events = new EventBus();
    sessions = new ChatSessionRegistry();
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-create-spec-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    emitted = [];
    callOrder = [];
    events.subscribe((e) => emitted.push(e));
    extractGrillSession = vi.fn<ExtractGrillSession>(async () => {
      callOrder.push("extract");
      return GRILL_SESSION;
    });
    synthesizeSpec = vi.fn<SynthesizeSpec>(async (input) => {
      callOrder.push("synthesize");
      expect(input.grillSession).toBe(GRILL_SESSION);
      expect(input.grillSession).not.toContain("role");
      const exchangeRel = projectStoreExchangePath(input.cardId, "spec.md");
      const abs = path.join(repoPath, ".jeeves", exchangeRel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, SPEC_MARKDOWN);
      // Real synthesizeSpec harvests; mock mirrors that contract.
      artifacts.harvest(
        path.join(repoPath, ".jeeves"),
        [{ exchangePath: exchangeRel, kind: "spec", stepKey: "spec" }],
        { cardId: input.cardId, round: 0, sourceSkill: "to-spec" },
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
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events,
      artifacts,
      sessions,
      createSpec: createCreateSpec({
        store,
        artifacts,
        sessions,
        engine,
        extractGrillSession,
        synthesizeSpec,
      }),
      promptsRoot: path.resolve(import.meta.dirname, "../../prompts"),
    };
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function featureInGrill(): string {
    const card = store.createCard(project.id);
    store.updateCard(card.id, {
      title: "Workout streaks",
      description: "Track gym visits.",
    });
    return store.decideKind(card.id, "feature").card.id;
  }

  function seedTranscript(cardId: string, messages: UIMessage[] = sampleTranscript) {
    artifacts.upsertTranscript(cardId, "grill", 0, messages);
  }

  it("extracts Grill session, synthesizes Spec, harvests, hands off, and emits", async () => {
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
    expect(synthesizeSpec).toHaveBeenCalledOnce();
    expect(synthesizeSpec.mock.calls[0]![0]).toMatchObject({
      cardId,
      repoPath,
      grillSession: GRILL_SESSION,
      cardTitle: "Workout streaks",
      cardDescription: "Track gym visits.",
    });

    const grill = artifacts.latest(cardId, {
      stepKey: "grill",
      round: 0,
      kind: "grill",
    });
    expect(grill).toBeTruthy();
    expect(artifacts.readBody(grill!)).toContain("## Q1:");

    const spec = artifacts.latest(cardId, {
      stepKey: "spec",
      round: 0,
      kind: "spec",
    });
    expect(spec).toBeTruthy();
    expect(artifacts.readBody(spec!)).toContain("## Problem Statement");
    expect(
      fs.existsSync(path.join(repoPath, ".jeeves", "exchange", cardId, "spec.md")),
    ).toBe(false);

    expect(conn.displacedWith).toEqual(["closing grill for spec synthesis"]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBeUndefined();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "card.updated",
      card: { id: cardId },
    });
  });

  it("closes ACP before synthesis, and synthesizes before hand-off", async () => {
    const cardId = featureInGrill();
    seedTranscript(cardId);
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);

    const originalClose = sessions.close.bind(sessions);
    sessions.close = (key, reason) => {
      callOrder.push("close");
      originalClose(key, reason);
    };
    const originalHandOff = store.handOffGrillToSpec.bind(store);
    store.handOffGrillToSpec = (id) => {
      callOrder.push("handOff");
      return originalHandOff(id);
    };

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(["extract", "close", "synthesize", "handOff"]);
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
    expect(
      artifacts.latest(cardId, { stepKey: "spec", round: 0, kind: "spec" }),
    ).toBeTruthy();
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
    expect(synthesizeSpec).not.toHaveBeenCalled();
    expect(conn.displacedWith).toEqual([]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBe(conn);
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );
  });

  it("returns 502 when extract fails without synthesizing, handing off, or closing", async () => {
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
    expect(synthesizeSpec).not.toHaveBeenCalled();
    expect(artifacts.latest(cardId, { stepKey: "grill", round: 0, kind: "grill" })).toBeUndefined();
    expect(conn.displacedWith).toEqual([]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBe(conn);
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );
    expect(emitted).toHaveLength(0);
  });

  it("returns 502 when synthesis/harvest fails: no hand-off, grill stays needs-user, ACP already closed", async () => {
    const cardId = featureInGrill();
    seedTranscript(cardId);
    const conn = fakeConn();
    sessions.claim({ cardId, stepKey: "grill", round: 0 }, conn);
    synthesizeSpec.mockRejectedValueOnce(
      new SpecSynthesisError("ACP timed out"),
    );

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "ACP timed out" });
    expect(conn.displacedWith).toEqual(["closing grill for spec synthesis"]);
    expect(sessions.get({ cardId, stepKey: "grill", round: 0 })).toBeUndefined();
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "spec")?.status).toBe(
      "pending",
    );
    expect(
      artifacts.latest(cardId, { stepKey: "spec", round: 0, kind: "spec" }),
    ).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it("returns 502 when synthesizeSpec reports missing exchange (no step advance)", async () => {
    const cardId = featureInGrill();
    seedTranscript(cardId);
    synthesizeSpec.mockRejectedValueOnce(
      new SpecSynthesisError("missing required exchange file: exchange/x/spec.md"),
    );

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${cardId}/create-spec`, {
      method: "POST",
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/missing required exchange file/i),
    });
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
    expect(synthesizeSpec).not.toHaveBeenCalled();
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
