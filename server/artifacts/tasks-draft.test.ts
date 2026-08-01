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

  it("rejects cycles in the blocker graph with task numbers", () => {
    expect(() =>
      parseTasksDraft({
        tasks: [
          { id: "a", title: "A", description: "", dependsOn: ["b"] },
          { id: "b", title: "B", description: "", dependsOn: ["a"] },
        ],
      }),
    ).toThrow("Circular dependency between Tasks 1 and 2");
  });

  it("names only the first cycle when reporting circular dependencies", () => {
    expect(() =>
      parseTasksDraft({
        tasks: [
          { id: "a", title: "A", description: "", dependsOn: [] },
          { id: "b", title: "B", description: "", dependsOn: ["c"] },
          { id: "c", title: "C", description: "", dependsOn: ["d"] },
          { id: "d", title: "D", description: "", dependsOn: ["b"] },
        ],
      }),
    ).toThrow("Circular dependency between Tasks 2, 3, and 4");
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

  it("preserves tip ids from exchange id fields on revise", () => {
    const tip = normalizeTasksDraft(
      {
        tasks: [
          {
            id: "keep-a",
            title: "API (revised)",
            description: "api",
            depends_on: [],
          },
          {
            id: "keep-b",
            title: "UI",
            description: "ui",
            depends_on: [0],
          },
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

  it("preserves ids across insert and reorder when exchange carries ids", () => {
    const tip = normalizeTasksDraft(
      {
        tasks: [
          {
            id: "keep-b",
            title: "UI first",
            description: "",
            depends_on: [],
          },
          { title: "Inserted", description: "", depends_on: [0] },
          {
            id: "keep-a",
            title: "API last",
            description: "",
            depends_on: [],
          },
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
    expect(tip.tasks.map((t) => t.id)).toEqual(["keep-b", "new-0", "keep-a"]);
    expect(tip.tasks[1]!.dependsOn).toEqual(["keep-b"]);
  });

  it("rejects unknown exchange ids when revising a tip", () => {
    expect(() =>
      normalizeTasksDraft(
        {
          tasks: [
            {
              id: "ghost",
              title: "Nope",
              description: "",
              depends_on: [],
            },
          ],
        },
        {
          previousTip: {
            tasks: [
              { id: "keep-a", title: "API", description: "", dependsOn: [] },
            ],
          },
        },
      ),
    ).toThrow(/unknown task id/i);
  });

  it("does not reuse prior tip ids by array index alone", () => {
    const tip = normalizeTasksDraft(
      {
        tasks: [
          { title: "Swapped order A", description: "", depends_on: [] },
          { title: "Swapped order B", description: "", depends_on: [0] },
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
    expect(tip.tasks.map((t) => t.id)).toEqual(["new-0", "new-1"]);
    expect(tip.tasks[1]!.dependsOn).toEqual(["new-0"]);
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
