import { nanoid } from "nanoid";
import { z } from "zod";

/** Skill / exchange shape — `depends_on` is 0-based indices into `tasks`. */
export const TasksDraftExchangeSchema = z.object({
  tasks: z.array(
    z.object({
      /** Tip id from a prior tip — required for revise id preserve; omit for new tasks. */
      id: z.string().min(1).optional(),
      title: z.string().min(1, "title must be non-empty"),
      description: z.string().default(""),
      depends_on: z.array(z.number().int().nonnegative()).default([]),
    }),
  ),
});

export type TasksDraftExchange = z.infer<typeof TasksDraftExchangeSchema>;

const TasksDraftTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1, "title must be non-empty"),
  description: z.string(),
  dependsOn: z.array(z.string()).default([]),
});

/** Working tip after host normalize — stable ids + id-based `dependsOn`. */
export const TasksDraftSchema = z
  .object({
    tasks: z.array(TasksDraftTaskSchema),
  })
  .superRefine((draft, ctx) => {
    const ids = new Set(draft.tasks.map((t) => t.id));
    if (ids.size !== draft.tasks.length) {
      ctx.addIssue({
        code: "custom",
        message: "task ids must be unique",
        path: ["tasks"],
      });
    }
    for (const [i, task] of draft.tasks.entries()) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown dependsOn id: ${dep}`,
            path: ["tasks", i, "dependsOn"],
          });
        }
        if (dep === task.id) {
          ctx.addIssue({
            code: "custom",
            message: "task cannot depend on itself",
            path: ["tasks", i, "dependsOn"],
          });
        }
      }
    }
    const cycle = findCycle(draft.tasks);
    if (cycle) {
      ctx.addIssue({
        code: "custom",
        message: formatCircularDependency(cycle, draft.tasks),
        path: ["tasks"],
      });
    }
  });

export type TasksDraft = z.infer<typeof TasksDraftSchema>;
export type TasksDraftTask = z.infer<typeof TasksDraftTaskSchema>;

export const EMPTY_TASKS_DRAFT: TasksDraft = { tasks: [] };

export class TasksDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TasksDraftError";
  }
}

/** Validate and parse a working tip. Throws TasksDraftError on failure. */
export function parseTasksDraft(raw: unknown): TasksDraft {
  const result = TasksDraftSchema.safeParse(raw);
  if (!result.success) {
    throw new TasksDraftError(formatZodError(result.error));
  }
  return result.data;
}

/** Validate exchange JSON (skill output). Throws TasksDraftError on failure. */
export function parseTasksDraftExchange(raw: unknown): TasksDraftExchange {
  const result = TasksDraftExchangeSchema.safeParse(raw);
  if (!result.success) {
    throw new TasksDraftError(formatZodError(result.error));
  }
  return result.data;
}

export type NormalizeTasksDraftOptions = {
  /**
   * Prior tip — when present, reuse ids only from explicit exchange `id`
   * fields that already exist on the tip (revise harvest). Unknown ids reject.
   * Slots without `id` get fresh ids (never by array index).
   */
  previousTip?: TasksDraft;
  assignId?: () => string;
};

/**
 * Map exchange-style `depends_on` indices → stable `id` / `dependsOn`.
 * Without `previousTip`, assigns new ids for every task (Create Tasks).
 * With `previousTip`, preserves ids only when the exchange carries a known tip id.
 */
export function normalizeTasksDraft(
  exchange: TasksDraftExchange,
  assignIdOrOpts: (() => string) | NormalizeTasksDraftOptions = () =>
    nanoid(10),
): TasksDraft {
  const opts: NormalizeTasksDraftOptions =
    typeof assignIdOrOpts === "function"
      ? { assignId: assignIdOrOpts }
      : assignIdOrOpts;
  const assignId = opts.assignId ?? (() => nanoid(10));
  const previousById = new Map(
    (opts.previousTip?.tasks ?? []).map((t) => [t.id, t]),
  );
  const revising = previousById.size > 0;
  const claimed = new Set<string>();
  const ids = exchange.tasks.map((task) => {
    if (!revising || task.id == null) {
      return assignId();
    }
    if (!previousById.has(task.id)) {
      throw new TasksDraftError(`unknown task id: ${task.id}`);
    }
    if (claimed.has(task.id)) {
      throw new TasksDraftError(`duplicate task id in exchange: ${task.id}`);
    }
    claimed.add(task.id);
    return task.id;
  });
  const tasks: TasksDraftTask[] = exchange.tasks.map((task, i) => ({
    id: ids[i]!,
    title: task.title,
    description: task.description,
    dependsOn: task.depends_on
      .filter((idx) => idx >= 0 && idx < ids.length && idx !== i)
      .map((idx) => ids[idx]!),
  }));
  return parseTasksDraft({ tasks });
}

/** Remove a task and scrub edges that pointed at it. */
export function deleteTaskFromDraft(
  draft: TasksDraft,
  taskId: string,
): TasksDraft {
  if (!draft.tasks.some((t) => t.id === taskId)) {
    throw new TasksDraftError(`task not found: ${taskId}`);
  }
  return parseTasksDraft({
    tasks: draft.tasks
      .filter((t) => t.id !== taskId)
      .map((t) => ({
        ...t,
        dependsOn: t.dependsOn.filter((id) => id !== taskId),
      })),
  });
}

/** Harvest/validate hook: parse exchange JSON string, then normalize to tip shape. */
export function validateAndNormalizeExchange(
  raw: string,
  opts?: NormalizeTasksDraftOptions,
): TasksDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TasksDraftError("tasks-draft exchange is not valid JSON");
  }
  return normalizeTasksDraft(parseTasksDraftExchange(parsed), opts);
}

/** First cycle as task ids (no closing repeat), or null if the graph is a DAG. */
function findCycle(tasks: TasksDraftTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return start >= 0 ? stack.slice(start) : [id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const task of tasks) {
    const cycle = dfs(task.id);
    if (cycle) return cycle;
  }
  return null;
}

/** 1-based tile numbers, matching the Tasks UI ("1. Title"). */
function formatCircularDependency(
  cycleIds: string[],
  tasks: TasksDraftTask[],
): string {
  const nums = cycleIds
    .map((id) => tasks.findIndex((t) => t.id === id))
    .filter((i) => i >= 0)
    .map((i) => String(i + 1));
  if (nums.length === 0) return "Circular dependency between tasks";
  if (nums.length === 1) return `Circular dependency on Task ${nums[0]}`;
  if (nums.length === 2) {
    return `Circular dependency between Tasks ${nums[0]} and ${nums[1]}`;
  }
  return `Circular dependency between Tasks ${nums.slice(0, -1).join(", ")}, and ${nums[nums.length - 1]}`;
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => i.message).join("; ");
}
