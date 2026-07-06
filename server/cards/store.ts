import { asc, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import { cards, projects, type Card, type Project } from "../db/schema.js";

/**
 * CardStore — the slice-1 seam over SQLite. Hides the unified card model and
 * every derivation rule; routes and the client are thin adapters over this.
 */
export class CardStore {
  constructor(private readonly db: Db) {}

  /** Idempotently seed the single default project (slice 1: no picker). */
  ensureDefaultProject(name: string, repoPath: string): Project {
    const existing = this.db.select().from(projects).limit(1).all();
    if (existing.length > 0) return existing[0];
    const project: Project = {
      id: nanoid(10),
      name,
      repoPath,
      createdAt: new Date(),
    };
    this.db.insert(projects).values(project).run();
    return project;
  }

  /**
   * Create an empty card at the bottom of Backlog (prototype UX: "+ Add
   * card" inserts immediately, then navigates to the Info view).
   */
  createCard(projectId: string): Card {
    const [{ maxPosition }] = this.db
      .select({ maxPosition: max(cards.position) })
      .from(cards)
      .where(eq(cards.projectId, projectId))
      .all();
    const card: Card = {
      id: nanoid(10),
      projectId,
      kind: null,
      status: "active",
      column: "backlog",
      title: "",
      description: "",
      position: (maxPosition ?? -1) + 1,
      createdAt: new Date(),
    };
    this.db.insert(cards).values(card).run();
    return card;
  }

  /** Board query: active cards only, in column order. */
  listCards(projectId: string): Card[] {
    return this.db
      .select()
      .from(cards)
      .where(eq(cards.projectId, projectId))
      .orderBy(asc(cards.position))
      .all()
      .filter((c) => c.status === "active");
  }

  getCard(id: string): Card | undefined {
    return this.db.select().from(cards).where(eq(cards.id, id)).get();
  }

  updateCard(
    id: string,
    patch: Partial<Pick<Card, "title" | "description">>,
  ): Card | undefined {
    const fields: Partial<Pick<Card, "title" | "description">> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.description !== undefined) fields.description = patch.description;
    if (Object.keys(fields).length > 0) {
      this.db.update(cards).set(fields).where(eq(cards.id, id)).run();
    }
    return this.getCard(id);
  }

  /** Hard delete (slice 1: cleans up abandoned empty cards). */
  deleteCard(id: string): boolean {
    const result = this.db.delete(cards).where(eq(cards.id, id)).run();
    return result.changes > 0;
  }
}
