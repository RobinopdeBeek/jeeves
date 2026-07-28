import { describe, expect, it } from "vitest";
import {
  deleteTaskFromDraft,
  normalizeTasksDraft,
  parseTasksDraft,
  parseTasksDraftExchange,
  TasksDraftError,
  validateAndNormalizeExchange,
} from "./tasks-draft.js";

describe("tasks-draft schema", () => {
  it("accepts a valid working tip", () => {
    const tip = parseTasksDraft({
      tasks: [
        { id: "a", title: "API", description: "d", dependsOn: [] },
        { id: "b", title: "UI", description: "", dependsOn: ["a"] },
      ],
    });
    expect(tip.tasks).toHaveLength(2);
    expect(tip.tasks[1]!.dependsOn).toEqual(["a"]);
  });

  it("accepts an empty tip", () => {
    expect(parseTasksDraft({ tasks: [] })).toEqual({ tasks: [] });
  });

  it("rejects empty titles", () => {
    expect(() =>
      parseTasksDraft({
        tasks: [{ id: "a", title: "", description: "", dependsOn: [] }],
      }),
    ).toThrow(TasksDraftError);
  });

  it("rejects cycles in the blocker graph", () => {
    expect(() =>
      parseTasksDraft({
        tasks: [
          { id: "a", title: "A", description: "", dependsOn: ["b"] },
          { id: "b", title: "B", description: "", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/DAG|cycle/i);
  });

  it("rejects unknown dependsOn ids", () => {
    expect(() =>
      parseTasksDraft({
        tasks: [
          { id: "a", title: "A", description: "", dependsOn: ["missing"] },
        ],
      }),
    ).toThrow(/unknown dependsOn/i);
  });
});

describe("normalizeTasksDraft", () => {
  it("maps depends_on indices to stable ids", () => {
    const tip = normalizeTasksDraft(
      {
        tasks: [
          { title: "API", description: "api", depends_on: [] },
          { title: "UI", description: "ui", depends_on: [0] },
        ],
      },
      (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
    );
    expect(tip.tasks).toEqual([
      { id: "id-0", title: "API", description: "api", dependsOn: [] },
      { id: "id-1", title: "UI", description: "ui", dependsOn: ["id-0"] },
    ]);
  });

  it("rejects exchange tasks with empty titles", () => {
    expect(() =>
      parseTasksDraftExchange({
        tasks: [{ title: "", description: "", depends_on: [] }],
      }),
    ).toThrow(TasksDraftError);
  });

  it("validateAndNormalizeExchange parses JSON then normalizes", () => {
    const tip = validateAndNormalizeExchange(
      JSON.stringify({
        tasks: [{ title: "Only", description: "", depends_on: [] }],
      }),
    );
    expect(tip.tasks).toHaveLength(1);
    expect(tip.tasks[0]!.title).toBe("Only");
    expect(tip.tasks[0]!.id).toBeTruthy();
  });

  it("preserves tip ids by index on revise normalize", () => {
    const tip = normalizeTasksDraft(
      {
        tasks: [
          { title: "API (revised)", description: "api", depends_on: [] },
          { title: "UI", description: "ui", depends_on: [0] },
          { title: "New", description: "", depends_on: [] },
        ],
      },
      {
        previousTip: {
          tasks: [
            { id: "keep-a", title: "API", description: "", dependsOn: [] },
            { id: "keep-b", title: "UI", description: "", dependsOn: ["keep-a"] },
          ],
        },
        assignId: (() => {
          let n = 0;
          return () => `new-${n++}`;
        })(),
      },
    );
    expect(tip.tasks.map((t) => t.id)).toEqual(["keep-a", "keep-b", "new-0"]);
    expect(tip.tasks[1]!.dependsOn).toEqual(["keep-a"]);
    expect(tip.tasks[0]!.title).toBe("API (revised)");
  });
});

describe("deleteTaskFromDraft", () => {
  it("removes the task and cleans inbound edges", () => {
    const next = deleteTaskFromDraft(
      {
        tasks: [
          { id: "a", title: "A", description: "", dependsOn: [] },
          { id: "b", title: "B", description: "", dependsOn: ["a"] },
          { id: "c", title: "C", description: "", dependsOn: ["a", "b"] },
        ],
      },
      "a",
    );
    expect(next.tasks.map((t) => t.id)).toEqual(["b", "c"]);
    expect(next.tasks.find((t) => t.id === "b")!.dependsOn).toEqual([]);
    expect(next.tasks.find((t) => t.id === "c")!.dependsOn).toEqual(["b"]);
  });

  it("throws when the task is missing", () => {
    expect(() => deleteTaskFromDraft({ tasks: [] }, "x")).toThrow(/not found/i);
  });
});
