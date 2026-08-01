import { describe, expect, it } from "vitest";
import {
  frameTasksAssistUserMessage,
  stripTasksAssistFrame,
} from "./tasks-assist-frame.js";

describe("frameTasksAssistUserMessage", () => {
  it("appends the tip JSON after a marker for the agent prompt", () => {
    const framed = frameTasksAssistUserMessage(
      "Split the API task",
      '{\n  "tasks": []\n}',
    );
    expect(framed).toContain("Split the API task");
    expect(framed).toContain("## Current tasks-draft tip JSON (from editor)");
    expect(framed).toContain('"tasks": []');
  });
});

describe("stripTasksAssistFrame", () => {
  it("returns the bare user text from a framed message", () => {
    const framed = frameTasksAssistUserMessage(
      "Split the API task",
      '{"tasks":[]}',
    );
    expect(stripTasksAssistFrame(framed)).toBe("Split the API task");
  });

  it("leaves unframed text alone", () => {
    expect(stripTasksAssistFrame("Just a question")).toBe("Just a question");
  });
});
