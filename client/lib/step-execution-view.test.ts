import { describe, expect, it } from "vitest";
import {
  initialLogOpen,
  logOpenAfterFinish,
  stepExecutionMode,
  usesFrozenArtifacts,
} from "./step-execution-view";

describe("step-execution-view", () => {
  describe("stepExecutionMode", () => {
    it("shows queued message while waiting in the FIFO queue", () => {
      expect(stepExecutionMode("queued")).toBe("queued");
    });

    it("streams live logs while the agent is working", () => {
      expect(stepExecutionMode("ai-working")).toBe("live");
    });

    it("freezes the log once the step is done or needs user input", () => {
      expect(stepExecutionMode("done")).toBe("frozen");
      expect(stepExecutionMode("needs-user")).toBe("frozen");
    });
  });

  describe("log collapse", () => {
    it("starts collapsed when opening an already completed step", () => {
      expect(initialLogOpen("done")).toBe(false);
      expect(initialLogOpen("needs-user")).toBe(false);
    });

    it("starts expanded while execution is live", () => {
      expect(initialLogOpen("ai-working")).toBe(true);
    });

    it("stays expanded after finish when the user was watching live", () => {
      expect(logOpenAfterFinish(true)).toBe(true);
    });

    it("collapses after finish when the user opens a completed step cold", () => {
      expect(logOpenAfterFinish(false)).toBe(false);
    });

    it("loads artifacts in frozen mode including after a failed run", () => {
      expect(usesFrozenArtifacts("frozen")).toBe(true);
      expect(usesFrozenArtifacts("live")).toBe(false);
      expect(usesFrozenArtifacts("queued")).toBe(false);
      expect(stepExecutionMode("needs-user")).toBe("frozen");
    });
  });
});
