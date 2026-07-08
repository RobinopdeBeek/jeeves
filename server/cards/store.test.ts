import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../db/index.js";
import { cardSteps } from "../db/schema.js";
import { CardStore } from "./store.js";

describe("CardStore", () => {
  let db: Db;
  let store: CardStore;
  let projectId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    projectId = store.ensureDefaultProject("jeeves", "C:/repo").id;
  });

  it("seeds the default project only once", () => {
    const again = store.ensureDefaultProject("other", "D:/elsewhere");
    expect(again.id).toBe(projectId);
    expect(again.name).toBe("jeeves");
  });

  it("creates an empty active card in Backlog with undecided kind", () => {
    const card = store.createCard(projectId);
    expect(card.title).toBe("");
    expect(card.description).toBe("");
    expect(card.kind).toBeNull();
    expect(card.status).toBe("active");
    expect(card.column).toBe("backlog");
  });

  it("creates an info step with needs-user on createCard", () => {
    const card = store.createCard(projectId);
    expect(card.steps).toEqual([
      {
        key: "info",
        status: "needs-user",
        label: "Info",
        stepKind: "human",
        column: "backlog",
      },
    ]);
  });

  it("appends new cards at increasing positions", () => {
    const a = store.createCard(projectId);
    const b = store.createCard(projectId);
    const c = store.createCard(projectId);
    expect(b.position).toBeGreaterThan(a.position);
    expect(c.position).toBeGreaterThan(b.position);
  });

  it("lists cards in position order", () => {
    const a = store.createCard(projectId);
    const b = store.createCard(projectId);
    const listed = store.listCards(projectId);
    expect(listed.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it("updates title and description independently", () => {
    const card = store.createCard(projectId);
    const titled = store.updateCard(card.id, { title: "Offline logging" });
    expect(titled?.title).toBe("Offline logging");
    expect(titled?.description).toBe("");

    const described = store.updateCard(card.id, {
      description: "Queue logs locally, sync when back online.",
    });
    expect(described?.title).toBe("Offline logging");
    expect(described?.description).toContain("Queue logs locally");
  });

  it("returns undefined when updating a missing card", () => {
    expect(store.updateCard("nope", { title: "x" })).toBeUndefined();
  });

  it("gets a card by id with enriched steps", () => {
    const card = store.createCard(projectId);
    const fetched = store.getCard(card.id);
    expect(fetched?.id).toBe(card.id);
    expect(fetched?.steps).toEqual([
      {
        key: "info",
        status: "needs-user",
        label: "Info",
        stepKind: "human",
        column: "backlog",
      },
    ]);
    expect(store.getCard("missing")).toBeUndefined();
  });

  it("hard-deletes a card", () => {
    const card = store.createCard(projectId);
    expect(store.deleteCard(card.id)).toBe(true);
    expect(store.getCard(card.id)).toBeUndefined();
    expect(store.deleteCard(card.id)).toBe(false);
  });

  describe("decideKind", () => {
    it("moves to Define on feature path with correct step statuses", () => {
      const card = store.createCard(projectId);
      store.updateCard(card.id, { title: "Workout streaks" });

      const decided = store.decideKind(card.id, "feature");
      expect(decided.kind).toBe("feature");
      expect(decided.column).toBe("define");
      expect(decided.steps).toEqual([
        { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
        { key: "grill", status: "needs-user", label: "Grill", stepKind: "ai-chat", column: "define" },
        { key: "prd", status: "pending", label: "PRD", stepKind: "ai-chat", column: "define" },
        { key: "tasks", status: "pending", label: "Tasks", stepKind: "ai-execution", column: "define" },
      ]);
    });

    it("moves to Implement on standalone path with plan queued and no execution", () => {
      const card = store.createCard(projectId);
      store.updateCard(card.id, { title: "Rest timer" });

      const decided = store.decideKind(card.id, "standalone");
      expect(decided.kind).toBe("task");
      expect(decided.column).toBe("implement");
      expect(decided.steps).toEqual([
        { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
        { key: "plan", status: "queued", label: "Plan", stepKind: "ai-execution", column: "implement" },
        { key: "impl", status: "pending", label: "Implement", stepKind: "ai-execution", column: "implement" },
        { key: "airev", status: "pending", label: "AI Review", stepKind: "ai-execution", column: "implement" },
      ]);
      // queued is persisted only — ExecutionEngine arrives in slice 3
      const rows = db.select().from(cardSteps).where(eq(cardSteps.cardId, card.id)).all();
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.stepKey === "plan")?.status).toBe("queued");
    });

    it("rejects blank title with 400", () => {
      const card = store.createCard(projectId);
      expect(() => store.decideKind(card.id, "feature")).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    });

    it("rejects whitespace-only title with 400", () => {
      const card = store.createCard(projectId);
      store.updateCard(card.id, { title: "   " });
      expect(() => store.decideKind(card.id, "standalone")).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    });

    it("rejects when kind is already set with 409", () => {
      const card = store.createCard(projectId);
      store.updateCard(card.id, { title: "Named" });
      store.decideKind(card.id, "feature");
      expect(() => store.decideKind(card.id, "standalone")).toThrow(
        expect.objectContaining({ status: 409 }),
      );
    });
  });

  it("listCards embeds steps with label and stepKind", () => {
    const card = store.createCard(projectId);
    store.updateCard(card.id, { title: "Feature X" });
    store.decideKind(card.id, "feature");

    const listed = store.listCards(projectId);
    const found = listed.find((c) => c.id === card.id);
    expect(found?.steps).toEqual([
      { key: "info", status: "done", label: "Info", stepKind: "human", column: "backlog" },
      { key: "grill", status: "needs-user", label: "Grill", stepKind: "ai-chat", column: "define" },
      { key: "prd", status: "pending", label: "PRD", stepKind: "ai-chat", column: "define" },
      { key: "tasks", status: "pending", label: "Tasks", stepKind: "ai-execution", column: "define" },
    ]);
  });
});
