import { and, asc, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import {
  cardSteps,
  cards,
  projects,
  type Card,
  type Project,
} from "../db/schema.js";
import {
  backlogEnrichedSteps,
  kindDecisionTransition,
  orderEnrichedSteps,
  type EnrichedStep,
  type KindPath,
  type StepKey,
  type StepStatus,
} from "../pipelines.js";

export { type EnrichedStep, type KindPath };

export class CardStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CardStoreError";
  }
}

export type CardWithSteps = Card & { steps: EnrichedStep[] };

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
  createCard(projectId: string): CardWithSteps {
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
    this.insertStep(card.id, "info", "needs-user");
    return this.attachSteps(card);
  }

  /** Board query: active cards only, in column order. */
  listCards(projectId: string): CardWithSteps[] {
    return this.db
      .select()
      .from(cards)
      .where(eq(cards.projectId, projectId))
      .orderBy(asc(cards.position))
      .all()
      .filter((c) => c.status === "active")
      .map((c) => this.attachSteps(c));
  }

  getCard(id: string): CardWithSteps | undefined {
    const card = this.db.select().from(cards).where(eq(cards.id, id)).get();
    return card ? this.attachSteps(card) : undefined;
  }

  updateCard(
    id: string,
    patch: Partial<Pick<Card, "title" | "description">>,
  ): CardWithSteps | undefined {
    const fields: Partial<Pick<Card, "title" | "description">> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.description !== undefined) fields.description = patch.description;
    if (Object.keys(fields).length > 0) {
      this.db.update(cards).set(fields).where(eq(cards.id, id)).run();
    }
    return this.getCard(id);
  }

  /**
   * Irreversible kind decision: feature → Define, standalone task → Implement.
   * Delegates step/column transitions to PipelineEngine.
   */
  decideKind(cardId: string, path: KindPath): CardWithSteps {
    const card = this.db.select().from(cards).where(eq(cards.id, cardId)).get();
    if (!card) throw new CardStoreError(404, "card not found");
    if (!card.title.trim()) {
      throw new CardStoreError(400, "title is required");
    }
    if (card.kind !== null) {
      throw new CardStoreError(409, "kind already set");
    }

    const transition = kindDecisionTransition(path);
    this.db
      .update(cards)
      .set({ kind: transition.kind, column: transition.column })
      .where(eq(cards.id, cardId))
      .run();

    for (const step of transition.steps) {
      if (step.key === "info") {
        this.db
          .update(cardSteps)
          .set({ status: step.status })
          .where(
            and(eq(cardSteps.cardId, cardId), eq(cardSteps.stepKey, "info")),
          )
          .run();
      } else {
        this.insertStep(cardId, step.key, step.status);
      }
    }

    return this.getCard(cardId)!;
  }

  /** Hard delete (slice 1: cleans up abandoned empty cards). */
  deleteCard(id: string): boolean {
    const result = this.db.delete(cards).where(eq(cards.id, id)).run();
    return result.changes > 0;
  }

  private insertStep(
    cardId: string,
    stepKey: StepKey,
    status: StepStatus,
  ): void {
    this.db
      .insert(cardSteps)
      .values({
        id: nanoid(10),
        cardId,
        stepKey,
        status,
        startedAt: null,
        completedAt: null,
      })
      .run();
  }

  private loadStepRows(cardId: string) {
    return this.db
      .select()
      .from(cardSteps)
      .where(eq(cardSteps.cardId, cardId))
      .all();
  }

  private attachSteps(card: Card): CardWithSteps {
    const rows = this.loadStepRows(card.id);
    const stepRows = rows.map((r) => ({
      stepKey: r.stepKey as StepKey,
      status: r.status as StepStatus,
    }));

    const steps =
      card.kind === null || card.column === null
        ? backlogEnrichedSteps(stepRows)
        : orderEnrichedSteps(
            card.kind,
            card.column,
            false, // parent_card_id arrives in slice 7
            stepRows,
          );

    return { ...card, steps };
  }
}
