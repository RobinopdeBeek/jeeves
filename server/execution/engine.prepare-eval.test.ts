import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projects, runs } from "../db/schema.js";
import type { AgentRunner, RunAgentOptions, RunEvent } from "./runner.js";
import type { WorktreeLifecycle } from "./worktree-manager.js";
import {
  createEngineHarness,
  expectDiagnosticAttachment,
  fakeRunner,
  fakeWorktrees,
  airevOk,
  airevReworkOk,
  implementOk,
  makeEngine,
  makeEngineWithRunner,
  ok,
  planOk,
  queuedCard,
  runnerWithFinalize,
  stepStatus,
  tick,
  type EngineTestHarness,
} from "./engine.test-helpers.js";

describe("ExecutionEngine", () => {
  let harness: EngineTestHarness;

  beforeEach(() => {
    harness = createEngineHarness();
  });

  afterEach(() => {
    harness.dispose();
  });

  // Prepare Eval stub (slice 8.5)
  describe("Prepare Eval stub (slice 8.5)", () => {
    it("emits preparing copy on the run log while the host stub runs", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "prepeval",
        round: 0,
        kind: "runlog",
      });
      expect(runlog).toBeDefined();
      expect(harness.artifactStore.readBody(runlog!)).toContain(
        "Preparing interactive evaluation…",
      );
      const logEvents = harness.received.filter(
        (e) =>
          e.type === "run.log" &&
          e.cardId === card.id &&
          e.line.includes("Preparing interactive evaluation"),
      );
      expect(logEvents.length).toBeGreaterThan(0);
    });

    it("fails Prepare Eval when the stub leaves the source tree dirty", async () => {
      const card = queuedCard(harness);
      const { engine: setup } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);
      setup.enqueue(card.id, "plan");
      await setup.whenIdle();

      harness.store.setStepStatus(card.id, "prepeval", "queued");
      harness.store.setStepStatus(card.id, "review", "pending");

      const base = fakeWorktrees(harness.artifactRoot);
      const engine = makeEngineWithRunner(harness, fakeRunner([]).runner, {
        ...base,
        async worktreeStatus() {
          return "?? leaked.txt";
        },
      });

      engine.enqueue(card.id, "prepeval");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "prepeval")).toBe("needs-user");
      expect(stepStatus(harness, card.id, "review")).toBe("pending");
      expect(harness.runStore.latestForStep(card.id, "prepeval")?.error).toMatch(
        /dirty|source tree/i,
      );
    });

    it("fails Prepare Eval when the tip moves (source commit)", async () => {
      const card = queuedCard(harness);
      const { engine: setup } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);
      setup.enqueue(card.id, "plan");
      await setup.whenIdle();

      harness.store.setStepStatus(card.id, "prepeval", "queued");
      harness.store.setStepStatus(card.id, "review", "pending");

      const base = fakeWorktrees(harness.artifactRoot);
      let resolveCount = 0;
      const engine = makeEngineWithRunner(harness, fakeRunner([]).runner, {
        ...base,
        async resolveRef(_ref) {
          resolveCount += 1;
          // First resolve is tip-at-start; second is post-hostBody tip check.
          if (resolveCount === 1) return "tip-before";
          return "tip-after-commit";
        },
      });

      engine.enqueue(card.id, "prepeval");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "prepeval")).toBe("needs-user");
      expect(stepStatus(harness, card.id, "review")).toBe("pending");
      expect(harness.runStore.latestForStep(card.id, "prepeval")?.error).toMatch(
        /must not create commits/i,
      );
    });
  });
});
