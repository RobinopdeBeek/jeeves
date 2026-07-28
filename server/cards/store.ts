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
  advance,
  backlogEnrichedSteps,
  canCreateSpec,
  canCreateTasks,
  orderEnrichedSteps,
  type AdvancePlan,
  type AdvanceSideEffect,
  type AdvanceTrigger,
  type EnrichedStep,
  type KindPath,
  type StepKey,
  type StepStatus,
} from "../pipelines.js";

export { type EnrichedStep, type KindPath };
export type { AdvanceSideEffect, AdvanceTrigger };

export class CardStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CardStoreError";
  }
}

export type CardWithSteps = Card & {
  steps: EnrichedStep[];
  /** Same predicate as grill→spec hand-off (board Create Spec). */
  canCreateSpec: boolean;
  /** Same predicate as spec→tasks hand-off (board Create Tasks). */
  canCreateTasks: boolean;
  /**
   * True while POST create-spec is in flight for this card (in-memory).
   * Survives board↔card navigation so the Grill tab stays on the synthesizing UI.
   */
  creatingSpec: boolean;
  /**
   * True while POST create-tasks is in flight for this card (in-memory).
   * Survives board↔card navigation so the Spec tab stays on the synthesizing UI.
   */
  creatingTasks: boolean;
};

/**
 * CardStore — the slice-1 seam over SQLite. Hides the unified card model and
 * every derivation rule; routes and the client are thin adapters over this.
 */
export class CardStore {
  /** In-process: create-spec host op running for these card ids. */
  private readonly creatingSpecIds = new Set<string>();
  /** In-process: create-tasks host op running for these card ids. */
  private readonly creatingTasksIds = new Set<string>();

  constructor(private readonly db: Db) {}

  /** Mark/clear create-spec in flight so GET/SSE cards stay truthful across remounts. */
  setCreatingSpec(cardId: string, creating: boolean): void {
    if (creating) this.creatingSpecIds.add(cardId);
    else this.creatingSpecIds.delete(cardId);
  }

  isCreatingSpec(cardId: string): boolean {
    return this.creatingSpecIds.has(cardId);
  }

  /** Mark/clear create-tasks in flight so GET/SSE cards stay truthful across remounts. */
  setCreatingTasks(cardId: string, creating: boolean): void {
    if (creating) this.creatingTasksIds.add(cardId);
    else this.creatingTasksIds.delete(cardId);
  }

  isCreatingTasks(cardId: string): boolean {
    return this.creatingTasksIds.has(cardId);
  }

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
   * Persists PipelineEngine.advance patches; caller dispatches side-effects.
   */
  decideKind(cardId: string, path: KindPath): {
    card: CardWithSteps;
    sideEffects: AdvanceSideEffect[];
  } {
    const card = this.db.select().from(cards).where(eq(cards.id, cardId)).get();
    if (!card) throw new CardStoreError(404, "card not found");
    if (!card.title.trim()) {
      throw new CardStoreError(400, "title is required");
    }

    const plan = this.requireAdvance(
      { kind: card.kind, steps: this.stepStatuses(cardId) },
      { type: "kind-decision", path },
    );
    this.applyAdvancePlan(cardId, plan);
    return { card: this.getCard(cardId)!, sideEffects: plan.sideEffects };
  }

  /**
   * Transition a step's status (ExecutionEngine drives this during runs).
   * Stamps startedAt on entering ai-working and completedAt on done.
   */
  setStepStatus(
    cardId: string,
    stepKey: StepKey,
    status: StepStatus,
  ): CardWithSteps {
    const patch: Partial<typeof cardSteps.$inferInsert> = { status };
    if (status === "ai-working") patch.startedAt = new Date();
    if (status === "done") patch.completedAt = new Date();
    this.db
      .update(cardSteps)
      .set(patch)
      .where(and(eq(cardSteps.cardId, cardId), eq(cardSteps.stepKey, stepKey)))
      .run();
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    return card;
  }

  /** Transcript upserts are forbidden once the step is done (frozen). */
  assertTranscriptMutable(cardId: string, stepKey: StepKey): void {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    const step = card.steps.find((s) => s.key === stepKey);
    if (!step) throw new CardStoreError(404, `unknown step: ${stepKey}`);
    // Grill/Spec freeze on `done`. Tasks freezes when it leaves needs-user
    // (fan-out → awaiting) so the side-chat transcript stops upserting.
    if (stepKey === "tasks") {
      if (step.status !== "needs-user" && step.status !== "ai-working") {
        throw new CardStoreError(409, "transcript is frozen");
      }
      return;
    }
    if (step.status === "done") {
      throw new CardStoreError(409, "transcript is frozen");
    }
  }

  /** Spec upserts are forbidden once the Spec step is done (frozen). */
  assertSpecMutable(cardId: string): void {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    const step = card.steps.find((s) => s.key === "spec");
    if (!step) throw new CardStoreError(404, "unknown step: spec");
    if (step.status === "done") {
      throw new CardStoreError(409, "spec is frozen");
    }
  }

  /** Tasks-draft writes are forbidden once the Tasks step leaves needs-user. */
  assertTasksDraftMutable(cardId: string): void {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    const step = card.steps.find((s) => s.key === "tasks");
    if (!step) throw new CardStoreError(404, "unknown step: tasks");
    if (step.status !== "needs-user") {
      throw new CardStoreError(409, "tasks draft is frozen");
    }
  }

  /**
   * Validate grill→spec without mutating — routes close ACP before apply.
   */
  assertGrillToSpecHandOff(cardId: string): AdvancePlan & { ok: true } {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    if (this.creatingSpecIds.has(cardId)) {
      throw new CardStoreError(409, "spec synthesis already in progress");
    }
    return this.requireAdvance(card, { type: "grill-to-spec" });
  }

  /**
   * Grill → Spec hand-off: freeze grill as done and open Spec for the user.
   * Transition rules live in PipelineEngine; this applies them.
   * Does not check creatingSpec — create-spec holds that lock until after hand-off.
   */
  handOffGrillToSpec(cardId: string): {
    card: CardWithSteps;
    sideEffects: AdvanceSideEffect[];
  } {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    const plan = this.requireAdvance(card, { type: "grill-to-spec" });
    this.applyAdvancePlan(cardId, plan);
    return { card: this.getCard(cardId)!, sideEffects: plan.sideEffects };
  }

  /**
   * Validate spec→tasks without mutating — routes may close ACP before apply.
   */
  assertSpecToTasksHandOff(cardId: string): AdvancePlan & { ok: true } {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    if (this.creatingTasksIds.has(cardId)) {
      throw new CardStoreError(409, "tasks synthesis already in progress");
    }
    return this.requireAdvance(card, { type: "spec-to-tasks" });
  }

  /**
   * Spec → Tasks hand-off: freeze Spec as done and open Tasks for the user.
   * Does not check creatingTasks — create-tasks holds that lock until after hand-off.
   */
  handOffSpecToTasks(cardId: string): {
    card: CardWithSteps;
    sideEffects: AdvanceSideEffect[];
  } {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    const plan = this.requireAdvance(card, { type: "spec-to-tasks" });
    this.applyAdvancePlan(cardId, plan);
    return { card: this.getCard(cardId)!, sideEffects: plan.sideEffects };
  }

  /**
   * Apply a step-finished advance (ExecutionEngine after a run settles).
   */
  applyStepFinished(
    cardId: string,
    stepKey: StepKey,
    outcome: "succeeded" | "failed",
  ): { card: CardWithSteps; sideEffects: AdvanceSideEffect[] } {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    const plan = this.requireAdvance(card, {
      type: "step-finished",
      stepKey,
      outcome,
    });
    this.applyAdvancePlan(cardId, plan);
    return { card: this.getCard(cardId)!, sideEffects: plan.sideEffects };
  }

  private requireAdvance(
    card: {
      kind: Card["kind"];
      steps: Array<{ key: StepKey; status: StepStatus }>;
    },
    trigger: AdvanceTrigger,
  ): AdvancePlan & { ok: true } {
    const plan = advance(card, trigger);
    if (!plan.ok) {
      throw new CardStoreError(409, plan.reason);
    }
    return plan;
  }

  private applyAdvancePlan(cardId: string, plan: AdvancePlan & { ok: true }): void {
    if (plan.cardPatch) {
      this.db
        .update(cards)
        .set({ kind: plan.cardPatch.kind, column: plan.cardPatch.column })
        .where(eq(cards.id, cardId))
        .run();
    }
    if (plan.ensureSteps) {
      for (const step of plan.ensureSteps) {
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
    }
    for (const { key, status } of plan.stepPatches) {
      this.setStepStatus(cardId, key, status);
    }
  }

  private stepStatuses(
    cardId: string,
  ): Array<{ key: StepKey; status: StepStatus }> {
    return this.loadStepRows(cardId).map((r) => ({
      key: r.stepKey as StepKey,
      status: r.status as StepStatus,
    }));
  }

  /** Steps waiting for the ExecutionEngine, oldest card first (boot scan). */
  listQueuedSteps(): Array<{ cardId: string; stepKey: StepKey }> {
    return this.db
      .select({
        cardId: cardSteps.cardId,
        stepKey: cardSteps.stepKey,
        createdAt: cards.createdAt,
      })
      .from(cardSteps)
      .innerJoin(cards, eq(cardSteps.cardId, cards.id))
      .where(eq(cardSteps.status, "queued"))
      .orderBy(asc(cards.createdAt))
      .all()
      .map((r) => ({ cardId: r.cardId, stepKey: r.stepKey as StepKey }));
  }

  /** Target repo path for a card's project (the agent's cwd). */
  getRepoPath(cardId: string): string {
    const row = this.db
      .select({ repoPath: projects.repoPath })
      .from(cards)
      .innerJoin(projects, eq(cards.projectId, projects.id))
      .where(eq(cards.id, cardId))
      .get();
    if (!row) throw new CardStoreError(404, "card not found");
    return row.repoPath;
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

    return {
      ...card,
      steps,
      creatingSpec: this.creatingSpecIds.has(card.id),
      creatingTasks: this.creatingTasksIds.has(card.id),
      canCreateSpec:
        !this.creatingSpecIds.has(card.id) &&
        canCreateSpec(
          steps.map((s) => ({ key: s.key, status: s.status })),
        ),
      canCreateTasks:
        !this.creatingTasksIds.has(card.id) &&
        canCreateTasks(
          steps.map((s) => ({ key: s.key, status: s.status })),
        ),
    };
  }
}
