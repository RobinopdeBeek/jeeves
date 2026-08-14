import { describe, expect, it } from "vitest";
import {
  PLAN_INSUFFICIENT_INPUT,
  assertPlanHasEnoughInput,
} from "./step-policies.js";

describe("assertPlanHasEnoughInput", () => {
  it("accepts a non-empty card description", () => {
    expect(() =>
      assertPlanHasEnoughInput({
        description: "Persist countdown across reloads.",
        attachments: [],
      }),
    ).not.toThrow();
  });

  it("accepts an instructed Info attachment when the description is empty", () => {
    expect(() =>
      assertPlanHasEnoughInput({
        description: "  ",
        attachments: [
          {
            absolutePath: "/abs/wire.png",
            filename: "wire.png",
            instruction: "Match this layout",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects title-only input (empty description, no instructed attachment)", () => {
    expect(() =>
      assertPlanHasEnoughInput({
        description: "",
        attachments: [
          {
            absolutePath: "/abs/notes.md",
            filename: "notes.md",
            instruction: "  ",
          },
        ],
      }),
    ).toThrow(PLAN_INSUFFICIENT_INPUT);
  });
});
