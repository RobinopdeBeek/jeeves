import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
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

  it("gets a card by id", () => {
    const card = store.createCard(projectId);
    expect(store.getCard(card.id)?.id).toBe(card.id);
    expect(store.getCard("missing")).toBeUndefined();
  });

  it("hard-deletes a card", () => {
    const card = store.createCard(projectId);
    expect(store.deleteCard(card.id)).toBe(true);
    expect(store.getCard(card.id)).toBeUndefined();
    expect(store.deleteCard(card.id)).toBe(false);
  });
});
