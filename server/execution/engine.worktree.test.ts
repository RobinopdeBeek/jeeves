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

  // worktree base resolution (slice 8.1)
  describe("worktree base resolution (slice 8.1)", () => {
    function trackingWorktrees(root: string) {
      const createFromCalls: Array<{ branch: string; baseSha: string }> = [];
      const checkoutCalls: Array<{ branch: string }> = [];
      const resolvedRefs: string[] = [];
      const base = fakeWorktrees(root);
      const tipByBranch = new Map<string, string>();
      const worktrees: WorktreeLifecycle = {
        ...base,
        async resolveRef(ref) {
          resolvedRefs.push(ref);
          return tipByBranch.get(ref) ?? `sha-of-${ref}`;
        },
        async createFrom(branch, baseSha, worktreePath) {
          createFromCalls.push({ branch, baseSha });
          tipByBranch.set(branch, baseSha);
          await base.createFrom(branch, baseSha, worktreePath);
        },
        async checkoutExisting(branch, worktreePath) {
          checkoutCalls.push({ branch });
          await base.checkoutExisting(branch, worktreePath);
        },
      };
      return { worktrees, createFromCalls, checkoutCalls, resolvedRefs, tipByBranch };
    }

    it("first run resolves projects.default_branch, createFrom, and persists cards.branch", async () => {
      const card = queuedCard(harness);
      const { worktrees, createFromCalls, checkoutCalls, resolvedRefs } =
        trackingWorktrees(harness.artifactRoot);
      const { runner } = fakeRunner([planOk(), implementOk(), airevOk()]);
      const engine = makeEngineWithRunner(harness, runner, worktrees);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const branch = `jeeves/card-${card.id}`;
      expect(resolvedRefs).toEqual(["main", branch, branch, branch, branch]);
      expect(createFromCalls).toEqual([{ branch, baseSha: "sha-of-main" }]);
      expect(checkoutCalls).toEqual([{ branch }, { branch }, { branch }]);
      expect(harness.store.getCard(card.id)?.branch).toBe(branch);
      expect(harness.runStore.latestForStep(card.id, "plan")?.baseSha).toBe("sha-of-main");
      expect(stepStatus(harness, card.id, "implement")).toBe("done");
      expect(stepStatus(harness, card.id, "ai-review")).toBe("done");
      expect(stepStatus(harness, card.id, "prepare-human-review")).toBe("done");
    });

    it("uses a non-main projects.default_branch as the upstream ref", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ defaultBranch: "develop" })
        .where(eq(projects.id, project.id))
        .run();
      const card = harness.store.createCard(project.id);
      harness.store.updateCard(card.id, {
        title: "Develop base",
        description: "Persist countdown across reloads.",
      });
      const queued = harness.store.decideKind(card.id, "standalone").card;

      const { worktrees, createFromCalls, resolvedRefs } = trackingWorktrees(
        harness.artifactRoot,
      );
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([planOk(), implementOk(), airevOk()]).runner,
        worktrees,
      );

      engine.enqueue(queued.id, "plan");
      await engine.whenIdle();

      expect(resolvedRefs[0]).toBe("develop");
      expect(createFromCalls[0]?.baseSha).toBe("sha-of-develop");
    });

    it("later runs checkoutExisting at tip and never call createFrom with upstream", async () => {
      const card = queuedCard(harness);
      const tracked = trackingWorktrees(harness.artifactRoot);
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([planOk(), implementOk(), airevOk(), planOk(), implementOk(), airevOk()]).runner,
        tracked.worktrees,
      );

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();
      expect(tracked.createFromCalls).toHaveLength(1);
      expect(stepStatus(harness, card.id, "implement")).toBe("done");

      // Advance the durable tip, then re-queue Plan as a later run on the same branch.
      const branch = `jeeves/card-${card.id}`;
      tracked.tipByBranch.set(branch, "sha-after-implement");
      harness.store.setStepStatus(card.id, "plan", "queued");
      harness.store.setStepStatus(card.id, "implement", "pending");
      tracked.createFromCalls.length = 0;
      tracked.checkoutCalls.length = 0;
      tracked.resolvedRefs.length = 0;

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(tracked.checkoutCalls.length).toBeGreaterThanOrEqual(1);
      expect(tracked.checkoutCalls[0]).toEqual({ branch });
      expect(tracked.createFromCalls).toEqual([]);
      expect(tracked.resolvedRefs[0]).toBe(branch);
      expect(harness.runStore.latestForStep(card.id, "plan")?.baseSha).toBe(
        "sha-after-implement",
      );
    });

    it("retry of a failed run uses createFrom with the recorded base_sha", async () => {
      const card = queuedCard(harness);
      const tracked = trackingWorktrees(harness.artifactRoot);
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([
          { error: new Error("first attempt died") },
          planOk(),
          implementOk(),
          airevOk(),
        ]).runner,
        tracked.worktrees,
      );

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();
      expect(tracked.createFromCalls[0]?.baseSha).toBe("sha-of-main");
      expect(harness.store.getCard(card.id)?.branch).toBe(`jeeves/card-${card.id}`);

      tracked.createFromCalls.length = 0;
      tracked.checkoutCalls.length = 0;
      tracked.resolvedRefs.length = 0;

      engine.retry(card.id, "plan");
      await engine.whenIdle();

      expect(tracked.createFromCalls).toEqual([
        { branch: `jeeves/card-${card.id}`, baseSha: "sha-of-main" },
      ]);
      // Implement + AI Review + Prepare Human Review continuations after successful Plan retry.
      expect(tracked.checkoutCalls).toEqual([
        { branch: `jeeves/card-${card.id}` },
        { branch: `jeeves/card-${card.id}` },
        { branch: `jeeves/card-${card.id}` },
      ]);
      expect(tracked.resolvedRefs).toEqual([
        `jeeves/card-${card.id}`,
        `jeeves/card-${card.id}`,
        `jeeves/card-${card.id}`,
        // Prepare Human Review host stub re-resolves tip after writing the placeholder.
        `jeeves/card-${card.id}`,
      ]);
    });

    it("child first run resolves the parent feature branch tip", async () => {
      const projectId = harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id;
      const feature = harness.store.createCard(projectId);
      harness.store.updateCard(feature.id, { title: "Feature" });
      const featureId = harness.store.decideKind(feature.id, "feature").card.id;
      harness.store.handOffGrillToSpec(featureId);
      harness.store.handOffSpecToTasks(featureId);
      harness.artifactStore.appendTasksDraft(featureId, 0, {
        tasks: [
          { id: "a", title: "API", description: "endpoints", dependsOn: [] },
        ],
      });
      harness.store.setCardBranch(featureId, "jeeves/card-feature");
      const { children } = harness.store.fanOut(featureId);
      const child = children[0]!;
      expect(child.steps.find((s) => s.key === "plan")?.status).toBe("queued");

      const tracked = trackingWorktrees(harness.artifactRoot);
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([planOk(), implementOk(), airevOk()]).runner,
        tracked.worktrees,
      );

      engine.enqueue(child.id, "plan");
      await engine.whenIdle();

      const childBranch = `jeeves/card-${child.id}`;
      expect(tracked.resolvedRefs).toEqual([
        "jeeves/card-feature",
        childBranch,
        childBranch,
        childBranch,
        // Prepare Human Review host stub re-resolves tip after writing the placeholder.
        childBranch,
      ]);
      expect(tracked.createFromCalls).toEqual([
        {
          branch: childBranch,
          baseSha: "sha-of-jeeves/card-feature",
        },
      ]);
      expect(harness.store.getCard(child.id)?.branch).toBe(childBranch);
    });

    it("ensureBranch creates the feature branch from default_branch and records cards.branch", async () => {
      const projectId = harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id;
      const feature = harness.store.createCard(projectId);
      harness.store.updateCard(feature.id, { title: "Feature" });
      const featureId = harness.store.decideKind(feature.id, "feature").card.id;

      const ensured: Array<{ branch: string; baseSha: string }> = [];
      const base = fakeWorktrees(harness.artifactRoot);
      const worktrees: WorktreeLifecycle = {
        ...base,
        async ensureBranch(branch, baseSha) {
          ensured.push({ branch, baseSha });
        },
        async resolveRef(ref) {
          return `sha-of-${ref}`;
        },
      };
      const engine = makeEngineWithRunner(
        harness,
        fakeRunner([]).runner,
        worktrees,
      );

      await engine.ensureBranch(featureId);

      expect(ensured).toEqual([
        { branch: `jeeves/card-${featureId}`, baseSha: "sha-of-main" },
      ]);
      expect(harness.store.getCard(featureId)?.branch).toBe(
        `jeeves/card-${featureId}`,
      );
    });
  });

});
