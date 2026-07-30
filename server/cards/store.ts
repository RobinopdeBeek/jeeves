import { and, asc, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ArtifactStoreError,
  type ArtifactStore,
} from "../artifacts/store.js";
import {
  parseTasksDraft,
  TasksDraftError,
  type TasksDraft,
} from "../artifacts/tasks-draft.js";
import type { Db } from "../db/index.js";
import {
  cardBlockers,
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

export type BlockedByRef = { id: string; title: string };

/** Child task payload rich enough to render the same board `CardTile`. */
export type CardChildSummary = {
  id: string;
  title: string;
  description: string;
  kind: Card["kind"];
  status: Card["status"];
  column: Card["column"];
  position: number;
  steps: EnrichedStep[];
  blockedBy: BlockedByRef[];
  creatingSpec: boolean;
  creatingTasks: boolean;
  implementProgress: ImplementProgress | null;
};

export type ImplementProgress = {
  current: number;
  total: number;
};

/** Tip document returned by tip CRUD — includes append-only version count. */
export type TasksDraftTipView = TasksDraft & { versionCount: number };

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
  /** Cards this card is blocked by (from `card_blockers`). */
  blockedBy: BlockedByRef[];
  /** Child task summaries when this card is a feature parent. */
  children: CardChildSummary[];
  /**
   * Derived “Implementing Task X of Y” for a feature with fanned-out children.
   * `current` stays 0 until later slices track child completion.
   */
  implementProgress: ImplementProgress | null;
};

/**
 * CardStore — the slice-1 seam over SQLite. Hides the unified card model and
 * every derivation rule; routes and the client are thin adapters over this.
 * Tip Draft CRUD / fan-out use the optional ArtifactStore adapter (ADR 0014).
 */
export class CardStore {
  /** In-process: create-spec host op running for these card ids. */
  private readonly creatingSpecIds = new Set<string>();
  /** In-process: create-tasks host op running for these card ids. */
  private readonly creatingTasksIds = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly artifacts: ArtifactStore | null = null,
  ) {}

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
      parentCardId: null,
      kind: null,
      status: "active",
      column: "backlog",
      title: "",
      description: "",
      branch: null,
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

  /** Read tip + versionCount (empty tip when no versions). */
  readTasksTip(cardId: string, round = 0): TasksDraftTipView {
    const card = this.getCard(cardId);
    if (!card) throw new CardStoreError(404, "card not found");
    return this.tasksTipView(cardId, round);
  }

  /** Assert mutable, parse body, append tip version, return tip view. */
  saveTasksTip(cardId: string, raw: unknown, round = 0): TasksDraftTipView {
    this.assertTasksDraftMutable(cardId);
    let draft: TasksDraft;
    try {
      draft = parseTasksDraft(raw);
    } catch (err) {
      throw new CardStoreError(
        400,
        err instanceof TasksDraftError ? err.message : String(err),
      );
    }
    this.requireArtifacts().appendTasksDraft(cardId, round, draft, "human");
    return this.tasksTipView(cardId, round);
  }

  /** Assert mutable, delete task from tip, append version, return tip view. */
  deleteTaskFromTasksTip(
    cardId: string,
    taskId: string,
    round = 0,
  ): TasksDraftTipView {
    this.assertTasksDraftMutable(cardId);
    try {
      this.requireArtifacts().deleteTaskFromTasksDraft(cardId, round, taskId);
    } catch (err) {
      this.rethrowTipError(err);
    }
    return this.tasksTipView(cardId, round);
  }

  /** Assert mutable, undo tip (append previous), return tip view. */
  undoTasksTip(cardId: string, round = 0): TasksDraftTipView {
    this.assertTasksDraftMutable(cardId);
    try {
      this.requireArtifacts().undoTasksDraft(cardId, round);
    } catch (err) {
      this.rethrowTipError(err);
    }
    return this.tasksTipView(cardId, round);
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
   * Implement → fan-out: freeze tip, materialize child task cards + blockers,
   * set Tasks to awaiting. No child Plan enqueue. Second call → 409.
   */
  fanOut(
    cardId: string,
    round = 0,
  ): {
    card: CardWithSteps;
    children: CardWithSteps[];
    sideEffects: AdvanceSideEffect[];
  } {
    const artifacts = this.requireArtifacts();
    const parent = this.getCard(cardId);
    if (!parent) throw new CardStoreError(404, "card not found");
    if (parent.kind !== "feature") {
      throw new CardStoreError(409, "fan-out requires a feature card");
    }

    const plan = this.requireAdvance(parent, { type: "tasks-to-implement" });

    let tip: TasksDraft;
    try {
      tip = parseTasksDraft(artifacts.readTasksDraftTip(cardId, round));
    } catch (err) {
      throw new CardStoreError(
        400,
        err instanceof TasksDraftError ? err.message : String(err),
      );
    }
    if (tip.tasks.length < 1) {
      throw new CardStoreError(400, "fan-out requires at least one task");
    }
    if (tip.tasks.some((t) => !t.title.trim())) {
      throw new CardStoreError(400, "all task titles must be non-empty");
    }

    const childIds: string[] = [];
    const draftIdToCardId = new Map<string, string>();

    this.db.transaction(() => {
      artifacts.freezeTasksBreakdown(cardId, round);

      for (const [index, task] of tip.tasks.entries()) {
        const childId = nanoid(10);
        draftIdToCardId.set(task.id, childId);
        childIds.push(childId);
        this.db.insert(cards).values({
          id: childId,
          projectId: parent.projectId,
          parentCardId: cardId,
          kind: "task",
          status: "active",
          column: "implement",
          title: task.title.trim(),
          description: task.description,
          branch: null,
          position: index,
          createdAt: new Date(),
        }).run();
        this.insertStep(childId, "plan", "pending");
        this.insertStep(childId, "impl", "pending");
        this.insertStep(childId, "airev", "pending");
      }

      for (const task of tip.tasks) {
        const childId = draftIdToCardId.get(task.id)!;
        for (const depDraftId of task.dependsOn) {
          const blocksOn = draftIdToCardId.get(depDraftId);
          if (!blocksOn) continue;
          this.db
            .insert(cardBlockers)
            .values({ cardId: childId, blocksOnCardId: blocksOn })
            .run();
        }
      }

      this.applyAdvancePlan(cardId, plan);
    });

    return {
      card: this.getCard(cardId)!,
      children: childIds.map((id) => this.getCard(id)!),
      sideEffects: plan.sideEffects,
    };
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

  private requireArtifacts(): ArtifactStore {
    if (!this.artifacts) {
      throw new CardStoreError(500, "ArtifactStore not configured on CardStore");
    }
    return this.artifacts;
  }

  private tasksTipView(cardId: string, round: number): TasksDraftTipView {
    const artifacts = this.requireArtifacts();
    return {
      ...artifacts.readTasksDraftTip(cardId, round),
      versionCount: artifacts.tasksDraftVersionCount(cardId, round),
    };
  }

  private rethrowTipError(err: unknown): never {
    if (err instanceof TasksDraftError) {
      throw new CardStoreError(400, err.message);
    }
    if (err instanceof ArtifactStoreError) {
      throw new CardStoreError(
        err.message === "nothing to undo" ? 409 : 400,
        err.message,
      );
    }
    throw err;
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
    const hasParent = card.parentCardId != null;

    const steps =
      card.kind === null || card.column === null
        ? backlogEnrichedSteps(stepRows)
        : orderEnrichedSteps(card.kind, card.column, hasParent, stepRows);

    const blockedBy = this.loadBlockedBy(card.id);
    const children = this.loadChildren(card.id);
    const implementProgress =
      children.length > 0
        ? { current: 0, total: children.length }
        : null;

    return {
      ...card,
      steps,
      blockedBy,
      children,
      implementProgress,
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

  private loadBlockedBy(cardId: string): BlockedByRef[] {
    return this.db
      .select({
        id: cards.id,
        title: cards.title,
      })
      .from(cardBlockers)
      .innerJoin(cards, eq(cardBlockers.blocksOnCardId, cards.id))
      .where(eq(cardBlockers.cardId, cardId))
      .all();
  }

  private loadChildren(parentId: string): CardChildSummary[] {
    const kids = this.db
      .select()
      .from(cards)
      .where(eq(cards.parentCardId, parentId))
      .orderBy(asc(cards.position))
      .all();
    // Task children have no further descendants, so attachSteps → loadChildren
    // bottoms out immediately.
    return kids.map((kid) => {
      const full = this.attachSteps(kid);
      return {
        id: full.id,
        title: full.title,
        description: full.description,
        kind: full.kind,
        status: full.status,
        column: full.column,
        position: full.position,
        steps: full.steps,
        blockedBy: full.blockedBy,
        creatingSpec: full.creatingSpec,
        creatingTasks: full.creatingTasks,
        implementProgress: full.implementProgress,
      };
    });
  }
}
