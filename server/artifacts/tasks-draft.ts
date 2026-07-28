import { nanoid } from "nanoid";
import { z } from "zod";

/** Skill / exchange shape — `depends_on` is 0-based indices into `tasks`. */
export const TasksDraftExchangeSchema = z.object({
  tasks: z.array(
    z.object({
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
    if (hasCycle(draft.tasks)) {
      ctx.addIssue({
        code: "custom",
        message: "blocker graph must be a DAG (cycle detected)",
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
   * Prior tip — when present, reuse ids by index (revise harvest).
   * New / extra exchange slots get fresh ids.
   */
  previousTip?: TasksDraft;
  assignId?: () => string;
};

/**
 * Map exchange-style `depends_on` indices → stable `id` / `dependsOn`.
 * Without `previousTip`, assigns new ids for every task (Create Tasks).
 * With `previousTip`, preserves ids at matching indices (side-chat revise).
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
  const previous = opts.previousTip?.tasks ?? [];
  const ids = exchange.tasks.map((_, i) => previous[i]?.id ?? assignId());
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

function hasCycle(tasks: TasksDraftTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (dfs(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const task of tasks) {
    if (dfs(task.id)) return true;
  }
  return false;
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => i.message).join("; ");
}
