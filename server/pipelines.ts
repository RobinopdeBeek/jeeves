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
  | "prd"
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

export type KindPath = "feature" | "standalone";

export type CardKind = "feature" | "task";

export interface EnrichedStep {
  key: StepKey;
  status: StepStatus;
  label: string;
  stepKind: StepKind;
}

interface StepDef {
  label: string;
  stepKind: StepKind;
  column: ColumnId;
}

const STEP_DEFS: Record<StepKey, StepDef> = {
  info: { label: "Info", stepKind: "human", column: "backlog" },
  grill: { label: "Grill", stepKind: "ai-chat", column: "define" },
  prd: { label: "PRD", stepKind: "ai-chat", column: "define" },
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
  define: ["grill", "prd", "tasks"],
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
  return { key, status, label: def.label, stepKind: def.stepKind };
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
        { key: "prd", status: "pending" },
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

/** Backlog cards — only the Info step is persisted. */
export function backlogEnrichedSteps(
  rows: Array<{ stepKey: StepKey; status: StepStatus }>,
): EnrichedStep[] {
  return rows
    .filter((r) => r.stepKey === "info")
    .map((r) => enrichStep(r.stepKey, r.status));
}
