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
  VERIFY_CMD_FAIL,
  VERIFY_CMD_PASS,
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

  // AI Review (slice 8.4)
  describe("AI Review (slice 8.4)", () => {
    it("runs ai-review with plan and card-library attachments injected", async () => {
      const { CardAttachmentStore } = await import("../attachments/card-library.js");
      const cardAttachments = new CardAttachmentStore(harness.db, harness.artifactRoot);
      const card = queuedCard(harness);
      harness.store.updateCard(card.id, {
        description: "Persist countdown across reloads.",
      });
      const att = cardAttachments.add({
        cardId: card.id,
        filename: "wire.png",
        mediaType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        instruction: "Match this layout",
      });
      const { engine, calls } = makeEngine(
        harness,
        [planOk(), implementOk(), airevOk()],
        cardAttachments,
      );

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(calls).toHaveLength(3);
      expect(calls[2]!.prompt).toContain("AI Review");
      expect(calls[2]!.prompt).toContain("Tracer plan.");
      expect(calls[2]!.prompt).toContain("Persist countdown across reloads.");
      expect(calls[2]!.prompt).toContain("wire.png");
      expect(calls[2]!.prompt).toContain("Match this layout");
      expect(calls[2]!.prompt).toContain(cardAttachments.absolutePath(card.id, att.id)!);
      expect(calls[2]!.prompt).toContain(".jeeves/review.md");
      expect(harness.runStore.latestForStep(card.id, "ai-review")?.skill).toBe("ai-review");
      expect(harness.runStore.listForCard(card.id).filter((r) => r.stepKey === "ai-review")).toHaveLength(
        1,
      );
    });

    it("harvests review.md and advances through Prepare Human Review stub to Human Review", async () => {
      const card = queuedCard(harness);
      const { engine, calls } = makeEngine(harness, [
        planOk(),
        implementOk(),
        airevOk(),
      ]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const review = harness.artifactStore.latest(card.id, {
        stepKey: "ai-review",
        round: 0,
        kind: "review",
      });
      expect(review).toBeDefined();
      expect(harness.artifactStore.readBody(review!)).toContain("Clean review");
      expect(stepStatus(harness, card.id, "ai-review")).toBe("done");
      expect(harness.store.getCard(card.id)?.column).toBe("review");
      // Host stub — no AgentRunner call for prepare-human-review.
      expect(calls).toHaveLength(3);
      expect(stepStatus(harness, card.id, "prepare-human-review")).toBe("done");
      expect(stepStatus(harness, card.id, "human-review")).toBe("needs-user");

      const evalArtifact = harness.artifactStore.latest(card.id, {
        stepKey: "prepare-human-review",
        round: 0,
        kind: "human-review-report",
      });
      expect(evalArtifact).toBeDefined();
      expect(harness.artifactStore.readBody(evalArtifact!)).toContain(
        "Prepare Human Review stub",
      );
      expect(harness.runStore.latestForStep(card.id, "prepare-human-review")?.skill).toBe(
        "assemble-human-review",
      );
    });

    it("allows zero commits on a clean review and skips host verify", async () => {
      const card = queuedCard(harness);
      const { engine: setup } = makeEngine(harness, [planOk(), implementOk()]);
      // Stop after Implement by not providing airevOk — Implement still enqueues airev,
      // which fails without a script. Reset to a clean airev queued state instead.
      setup.enqueue(card.id, "plan");
      await setup.whenIdle();

      // Leave Implement done; park AI Review as queued with a branch tip ready.
      harness.store.setStepStatus(card.id, "ai-review", "queued");
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify([VERIFY_CMD_FAIL]) })
        .where(eq(projects.id, project.id))
        .run();

      const { engine } = makeEngine(harness, [airevOk()]);
      engine.enqueue(card.id, "ai-review");
      await engine.whenIdle();

      // Clean airev made no commits — verify_commands must not run (would fail).
      expect(stepStatus(harness, card.id, "ai-review")).toBe("done");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "ai-review",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).not.toMatch(/verify_commands failed/i);
      expect(harness.artifactStore.readBody(runlog!)).not.toMatch(
        /verify_commands: all commands passed/i,
      );
    });

    it("runs host verify when AI Review commits rework; verify fail → needs-user", async () => {
      const card = queuedCard(harness);
      const { engine: setup } = makeEngine(harness, [planOk(), implementOk()]);
      setup.enqueue(card.id, "plan");
      await setup.whenIdle();

      harness.store.setStepStatus(card.id, "ai-review", "queued");
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify([VERIFY_CMD_FAIL]) })
        .where(eq(projects.id, project.id))
        .run();

      const { engine } = makeEngine(harness, [airevReworkOk()]);
      engine.enqueue(card.id, "ai-review");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "ai-review")).toBe("needs-user");
      expect(harness.store.getCard(card.id)?.column).toBe("implement");
      const run = harness.runStore.latestForStep(card.id, "ai-review");
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/verify_commands failed/i);
    });

    it("passes AI Review with rework commits when verify_commands succeed", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify([VERIFY_CMD_PASS]) })
        .where(eq(projects.id, project.id))
        .run();
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [
        planOk(),
        implementOk(),
        airevReworkOk(),
      ]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "ai-review")).toBe("done");
      expect(harness.store.getCard(card.id)?.column).toBe("review");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "ai-review",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).toMatch(
        /verify_commands: all commands passed/i,
      );
    });

    it("fails AI Review when review.md is missing", async () => {
      const card = queuedCard(harness);
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([
          planOk(),
          implementOk(),
          { events: ok(), finalize: "implement" }, // commits but no review.md
        ]).runner,
      );

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "ai-review")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "ai-review")?.error).toMatch(
        /required exchange|postconditions|review/i,
      );
    });

    it("fails AI Review when the source tree is dirty after finalize", async () => {
      const card = queuedCard(harness);
      const runner: AgentRunner = {
        async *run(prompt, options) {
          if (prompt.includes("Plan implementation")) {
            const planDir = path.join(options.worktreePath, ".jeeves");
            fs.mkdirSync(planDir, { recursive: true });
            fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n\nDo it.\n");
            if (options.onFinalize) {
              await options.onFinalize({
                workspacePath: options.worktreePath,
                headSha: options.baseSha,
                baseSha: options.baseSha,
              });
            }
            yield { type: "result", status: "finished" };
            return;
          }
          if (prompt.includes("Implement task")) {
            if (options.onFinalize) {
              await options.onFinalize({
                workspacePath: options.worktreePath,
                headSha: `${options.baseSha}-impl`,
                baseSha: options.baseSha,
              });
            }
            yield { type: "result", status: "finished" };
            return;
          }
          const reviewDir = path.join(options.worktreePath, ".jeeves");
          fs.mkdirSync(reviewDir, { recursive: true });
          fs.writeFileSync(
            path.join(reviewDir, "review.md"),
            "# AI Review\n\nFindings noted.\n",
          );
          fs.writeFileSync(path.join(options.worktreePath, "leftover.ts"), "oops\n");
          if (options.onFinalize) {
            await options.onFinalize({
              workspacePath: options.worktreePath,
              headSha: options.baseSha,
              baseSha: options.baseSha,
            });
          }
          yield { type: "result", status: "finished" };
        },
      };
      const engine = makeEngineWithRunner(harness, runner);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "ai-review")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "ai-review")?.error).toMatch(/dirty/i);
    });

    it("does not produce a Human Review Report from AI Review (Prepare Human Review owns it)", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(
        harness.artifactStore.latest(card.id, {
          stepKey: "ai-review",
          round: 0,
          kind: "human-review-report",
        }),
      ).toBeUndefined();
      expect(
        harness.artifactStore.latest(card.id, {
          stepKey: "ai-review",
          round: 0,
          kind: "review",
        }),
      ).toBeDefined();
      // Slice 8.5 stub harvests the Human Review Report on prepare-human-review, not ai-review.
      expect(
        harness.artifactStore.latest(card.id, {
          stepKey: "prepare-human-review",
          round: 0,
          kind: "human-review-report",
        }),
      ).toBeDefined();
    });
  });

});
