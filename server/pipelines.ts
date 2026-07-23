/**
 * PipelineEngine — workflow-as-code. Pipelines are TypeScript constants;
 * the database stores per-card step state only (ADR 0002).
 */

export type ColumnId =
  | "backlog"
  | "define"
  | "implement"
  | "review"
  | "finalize";

export type StepKey =
  | "info"
  | "grill"
  | "spec"
  | "tasks"
  | "plan"
  | "impl"
  | "airev"
  | "review"
  | "document"
  | "deploy";

export type StepStatus =
  | "pending"
  | "queued"
  | "ai-working"
  | "needs-user"
  | "done";

export type StepKind = "human" | "ai-chat" | "ai-execution";

export const stepKeys = [
  "info",
  "grill",
  "spec",
  "tasks",
  "plan",
  "impl",
  "airev",
  "review",
  "document",
  "deploy",
] as const satisfies readonly StepKey[];

export function isStepKey(value: unknown): value is StepKey {
  return typeof value === "string" && (stepKeys as readonly string[]).includes(value);
}

export type KindPath = "feature" | "standalone";

export type CardKind = "feature" | "task";

export interface EnrichedStep {
  key: StepKey;
  status: StepStatus;
  label: string;
  stepKind: StepKind;
  column: ColumnId;
}

interface StepDef {
  label: string;
  stepKind: StepKind;
  column: ColumnId;
}

const STEP_DEFS: Record<StepKey, StepDef> = {
  info: { label: "Info", stepKind: "human", column: "backlog" },
  grill: { label: "Grill", stepKind: "ai-chat", column: "define" },
  spec: { label: "Spec", stepKind: "ai-chat", column: "define" },
  tasks: { label: "Tasks", stepKind: "ai-execution", column: "define" },
  plan: { label: "Plan", stepKind: "ai-execution", column: "implement" },
  impl: { label: "Implement", stepKind: "ai-execution", column: "implement" },
  airev: { label: "AI Review", stepKind: "ai-execution", column: "implement" },
  review: { label: "Human Review", stepKind: "human", column: "review" },
  document: { label: "Document", stepKind: "ai-execution", column: "finalize" },
  deploy: { label: "Deploy", stepKind: "ai-execution", column: "finalize" },
};

const COLUMN_STEPS: Record<ColumnId, StepKey[]> = {
  backlog: ["info"],
  define: ["grill", "spec", "tasks"],
  implement: ["plan", "impl", "airev"],
  review: ["review"],
  finalize: ["document", "deploy"],
};

const PIPELINES: Record<string, ColumnId[]> = {
  "feature:false": ["backlog", "define", "review", "finalize"],
  "task:false": ["backlog", "implement", "review", "finalize"],
  "task:true": ["backlog", "implement", "review"],
};

function pipelineKey(kind: CardKind, hasParent: boolean): string {
  return `${kind}:${hasParent}`;
}

/** Ordered columns for a card kind + parent link (workflow is code). */
export function getPipeline(kind: CardKind, hasParent: boolean): ColumnId[] {
  return PIPELINES[pipelineKey(kind, hasParent)];
}

export function enrichStep(key: StepKey, status: StepStatus): EnrichedStep {
  const def = STEP_DEFS[key];
  return {
    key,
    status,
    label: def.label,
    stepKind: def.stepKind,
    column: def.column,
  };
}

/** Step keys for a column, in display order. */
export function stepsForColumn(column: ColumnId): StepKey[] {
  return COLUMN_STEPS[column];
}

/** Ordered enriched steps from persisted rows up through the card's column. */
export function orderEnrichedSteps(
  kind: CardKind,
  column: ColumnId,
  hasParent: boolean,
  rows: Array<{ stepKey: StepKey; status: StepStatus }>,
): EnrichedStep[] {
  const pipeline = getPipeline(kind, hasParent);
  const colIdx = pipeline.indexOf(column);
  const orderedKeys: StepKey[] = [];
  for (let i = 0; i <= colIdx; i++) {
    orderedKeys.push(...stepsForColumn(pipeline[i]));
  }
  const byKey = new Map(rows.map((r) => [r.stepKey, r.status]));
  return orderedKeys
    .filter((key) => byKey.has(key))
    .map((key) => enrichStep(key, byKey.get(key)!));
}

/** Irreversible kind decision: column move + lazy step rows for the new column. */
export function kindDecisionTransition(path: KindPath): {
  kind: CardKind;
  column: ColumnId;
  steps: Array<{ key: StepKey; status: StepStatus }>;
} {
  if (path === "feature") {
    return {
      kind: "feature",
      column: "define",
      steps: [
        { key: "info", status: "done" },
        { key: "grill", status: "needs-user" },
        { key: "spec", status: "pending" },
        { key: "tasks", status: "pending" },
      ],
    };
  }
  return {
    kind: "task",
    column: "implement",
    steps: [
      { key: "info", status: "done" },
      { key: "plan", status: "queued" },
      { key: "impl", status: "pending" },
      { key: "airev", status: "pending" },
    ],
  };
}

/**
 * Grill → Spec hand-off: grill must be needs-user and spec pending.
 * Returns the status patches to apply, or a rejection reason.
 */
export function grillToSpecTransition(
  steps: Array<{ key: StepKey; status: StepStatus }>,
):
  | { ok: true; patches: Array<{ key: StepKey; status: StepStatus }> }
  | { ok: false; reason: string } {
  const grill = steps.find((s) => s.key === "grill");
  const spec = steps.find((s) => s.key === "spec");
  if (!grill || !spec) {
    return { ok: false, reason: "grill hand-off requires grill and spec steps" };
  }
  if (grill.status !== "needs-user") {
    return { ok: false, reason: "grill must be needs-user to hand off" };
  }
  if (spec.status !== "pending") {
    return { ok: false, reason: "spec must be pending to receive hand-off" };
  }
  return {
    ok: true,
    patches: [
      { key: "grill", status: "done" },
      { key: "spec", status: "needs-user" },
    ],
  };
}

/** Board/Create Spec affordance — same rules as grill→spec hand-off. */
export function canCreateSpec(
  steps: Array<{ key: StepKey; status: StepStatus }>,
): boolean {
  return grillToSpecTransition(steps).ok;
}

/** What triggered a pipeline advance (routes / engine are thin adapters). */
export type AdvanceTrigger =
  | { type: "kind-decision"; path: KindPath }
  | { type: "grill-to-spec" }
  | {
      type: "step-finished";
      stepKey: StepKey;
      outcome: "succeeded" | "failed";
    };

/** Declared follow-on work — adapters dispatch; PipelineEngine does not I/O. */
export type AdvanceSideEffect =
  | { type: "enqueue"; stepKey: StepKey }
  | {
      type: "close-chat";
      stepKey: StepKey;
      round: number;
      reason: string;
    };

export type AdvancePlan =
  | {
      ok: true;
      cardPatch?: { kind: CardKind; column: ColumnId };
      /** When set, replace/insert these step rows (kind decision). */
      ensureSteps?: Array<{ key: StepKey; status: StepStatus }>;
      stepPatches: Array<{ key: StepKey; status: StepStatus }>;
      sideEffects: AdvanceSideEffect[];
    }
  | { ok: false; reason: string };

/**
 * Pure workflow transition: patches + side-effects for a trigger.
 * CardStore persists; routes/engine dispatch effects (enqueue, close-chat).
 */
export function advance(
  card: {
    kind: CardKind | null;
    steps: Array<{ key: StepKey; status: StepStatus }>;
  },
  trigger: AdvanceTrigger,
): AdvancePlan {
  if (trigger.type === "kind-decision") {
    if (card.kind !== null) {
      return { ok: false, reason: "kind already set" };
    }
    const transition = kindDecisionTransition(trigger.path);
    const sideEffects: AdvanceSideEffect[] = [];
    for (const step of transition.steps) {
      if (step.status === "queued") {
        sideEffects.push({ type: "enqueue", stepKey: step.key });
      }
    }
    return {
      ok: true,
      cardPatch: { kind: transition.kind, column: transition.column },
      ensureSteps: transition.steps,
      stepPatches: [],
      sideEffects,
    };
  }

  if (trigger.type === "grill-to-spec") {
    const transition = grillToSpecTransition(card.steps);
    if (!transition.ok) return transition;
    return {
      ok: true,
      stepPatches: transition.patches,
      sideEffects: [
        {
          type: "close-chat",
          stepKey: "grill",
          round: 0,
          reason: "grill handed off to spec",
        },
      ],
    };
  }

  // step-finished: status patch for the completed step; future rules may
  // enqueue the next step / move columns here (seam exists even if minimal).
  const stepStatus: StepStatus =
    trigger.outcome === "succeeded" ? "done" : "needs-user";
  return {
    ok: true,
    stepPatches: [{ key: trigger.stepKey, status: stepStatus }],
    sideEffects: [],
  };
}

/** Backlog cards — only the Info step is persisted. */
export function backlogEnrichedSteps(
  rows: Array<{ stepKey: StepKey; status: StepStatus }>,
): EnrichedStep[] {
  return rows
    .filter((r) => r.stepKey === "info")
    .map((r) => enrichStep(r.stepKey, r.status));
}
