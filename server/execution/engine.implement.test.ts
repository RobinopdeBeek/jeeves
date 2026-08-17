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

  // Implement + verify_commands (slice 8.3b)
  describe("Implement + verify_commands (slice 8.3b)", () => {
    it("runs implement-task with plan and card-library attachments injected", async () => {
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
      expect(calls[1]!.prompt).toContain("Implement task");
      expect(calls[1]!.prompt).toContain("Tracer plan.");
      expect(calls[1]!.prompt).toContain("Persist countdown across reloads.");
      expect(calls[1]!.prompt).toContain("wire.png");
      expect(calls[1]!.prompt).toContain("Match this layout");
      expect(calls[1]!.prompt).toContain(cardAttachments.absolutePath(card.id, att.id)!);
      expect(calls[1]!.prompt).toContain("/tdd");
      expect(harness.runStore.latestForStep(card.id, "implement")?.skill).toBe("implement-task");
      expect(stepStatus(harness, card.id, "implement")).toBe("done");
      expect(stepStatus(harness, card.id, "ai-review")).toBe("done");
    });

    it("uses checkoutExisting for Implement so Plan commits survive on the tip", async () => {
      const card = queuedCard(harness);
      const checkoutCalls: string[] = [];
      const createFromCalls: string[] = [];
      const base = fakeWorktrees(harness.artifactRoot);
      const worktrees: WorktreeLifecycle = {
        ...base,
        async createFrom(branch, baseSha, worktreePath) {
          createFromCalls.push(branch);
          await base.createFrom(branch, baseSha, worktreePath);
        },
        async checkoutExisting(branch, worktreePath) {
          checkoutCalls.push(branch);
          await base.checkoutExisting(branch, worktreePath);
        },
      };
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([planOk(), implementOk(), airevOk()]).runner,
        worktrees,
      );

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(createFromCalls).toEqual([`jeeves/card-${card.id}`]);
      expect(checkoutCalls).toEqual([
        `jeeves/card-${card.id}`,
        `jeeves/card-${card.id}`,
        `jeeves/card-${card.id}`,
      ]);
      expect(stepStatus(harness, card.id, "implement")).toBe("done");
      expect(stepStatus(harness, card.id, "ai-review")).toBe("done");
      expect(stepStatus(harness, card.id, "prepare-human-review")).toBe("done");
    });

    it("fails Implement when the agent leaves no commits", async () => {
      const card = queuedCard(harness);
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([
          planOk(),
          { events: ok(), finalize: "plan" }, // wrong finalize — no commit
        ]).runner,
      );

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "plan")).toBe("done");
      expect(stepStatus(harness, card.id, "implement")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "implement")?.error).toMatch(
        /at least one commit/i,
      );
    });

    it("fails Implement when the source tree is dirty after finalize", async () => {
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
          fs.writeFileSync(path.join(options.worktreePath, "leftover.ts"), "oops\n");
          if (options.onFinalize) {
            await options.onFinalize({
              workspacePath: options.worktreePath,
              headSha: `${options.baseSha}-impl`,
              baseSha: options.baseSha,
            });
          }
          yield { type: "result", status: "finished" };
        },
      };
      const engine = makeEngineWithRunner(harness, runner);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "implement")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "implement")?.error).toMatch(/dirty/i);
    });

    it("skips verify_commands with a warning when null/empty", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "implement")).toBe("done");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "implement",
        round: 0,
        kind: "runlog",
      });
      expect(runlog).toBeDefined();
      expect(harness.artifactStore.readBody(runlog!)).toMatch(
        /verify_commands: skip/i,
      );
    });

    it("fails Implement to needs-user when verify_commands exits non-zero", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify([VERIFY_CMD_FAIL]) })
        .where(eq(projects.id, project.id))
        .run();
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "implement")).toBe("needs-user");
      const run = harness.runStore.latestForStep(card.id, "implement");
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/verify_commands failed/i);
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "implement",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).toMatch(/verify_commands failed/i);
    });

    it("passes Implement when verify_commands succeed", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify([VERIFY_CMD_PASS]) })
        .where(eq(projects.id, project.id))
        .run();
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "implement")).toBe("done");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "implement",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).toMatch(
        /verify_commands: all commands passed/i,
      );
    });
  });

});
