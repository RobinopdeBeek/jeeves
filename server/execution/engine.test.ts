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

  it("runs a queued Plan to done when the agent succeeds", async () => {
    const card = queuedCard(harness);
    const { engine, calls } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("done");
    expect(stepStatus(harness, card.id, "impl")).toBe("done");
    expect(stepStatus(harness, card.id, "airev")).toBe("done");

    const run = harness.runStore.latestForStep(card.id, "plan");
    expect(run?.status).toBe("succeeded");
    expect(run?.skill).toBe("plan-implementation");
    expect(run?.logPath).toContain(path.join("cards", card.id, "0"));

    expect(calls).toHaveLength(3);
    expect(calls[0].prompt).toContain("Plan implementation");
    expect(calls[0].prompt).toContain("Rest timer");
    expect(calls[0].prompt).toContain("manifest.json");
    expect(calls[0].options.cwd).toBe("C:/target-repo");
    expect(calls[0].options.branch).toBe(`jeeves/card-${card.id}`);
    expect(calls[0].options.worktreePath).toContain(path.join("worktrees", card.id));
    expect(calls[0].options.baseSha).toBe("abc123def456");
    expect(calls[0].options.onFinalize).toBeTypeOf("function");

    const plan = harness.artifactStore.latest(card.id, {
      stepKey: "plan",
      round: 0,
      kind: "plan",
    });
    expect(plan).toBeDefined();
    expect(harness.artifactStore.readContent(plan!)).toContain("Tracer plan.");
  });

  it("does not enqueue Implement when Plan fails", async () => {
    const card = queuedCard(harness);
    const { engine } = makeEngine(harness, [
      { error: new Error("agent crashed") },
      planOk(),
      implementOk(),
      airevOk(),
    ]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(stepStatus(harness, card.id, "impl")).toBe("pending");

    engine.retry(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("done");
    expect(stepStatus(harness, card.id, "impl")).toBe("done");
  });

  it("injects card-library attachments into the Plan prompt", async () => {
    const { CardAttachmentStore } = await import("../attachments/card-library.js");
    const cardAttachments = new CardAttachmentStore(harness.db, harness.artifactRoot);
    const card = queuedCard(harness);
    harness.store.updateCard(card.id, {
      description: "Keep the timer across reloads.",
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

    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("Keep the timer across reloads.");
    expect(prompt).toContain("wire.png");
    expect(prompt).toContain("Match this layout");
    expect(prompt).toContain(cardAttachments.absolutePath(card.id, att.id)!);
    expect(stepStatus(harness, card.id, "impl")).toBe("done");
  });

  it("treats an empty card attachment library as non-fatal", async () => {
    const { CardAttachmentStore } = await import("../attachments/card-library.js");
    const cardAttachments = new CardAttachmentStore(harness.db, harness.artifactRoot);
    const card = queuedCard(harness);
    const { engine, calls } = makeEngine(
      harness,
      [planOk(), implementOk(), airevOk()],
      cardAttachments,
    );

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(calls[0]!.prompt).toMatch(/Card attachments[\s\S]*\(none\)/);
    expect(stepStatus(harness, card.id, "plan")).toBe("done");
    expect(stepStatus(harness, card.id, "impl")).toBe("done");
  });

  it("injects the parent feature spec for a child task Plan", async () => {
    const projectId = harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    const feature = harness.store.createCard(projectId);
    harness.store.updateCard(feature.id, { title: "Workout streaks" });
    const featureId = harness.store.decideKind(feature.id, "feature").card.id;
    harness.store.handOffGrillToSpec(featureId);
    harness.artifactStore.save({
      cardId: featureId,
      stepKey: "spec",
      round: 0,
      kind: "spec",
      content: "# Spec\n\nStreaks must survive offline sync.\n",
      sourceSkill: "to-spec",
    });
    harness.store.handOffSpecToTasks(featureId);
    harness.artifactStore.appendTasksDraft(featureId, 0, {
      tasks: [
        {
          id: "t1",
          title: "API streak endpoint",
          description: "POST /streaks",
          dependsOn: [],
        },
      ],
    });
    harness.store.setCardBranch(featureId, "jeeves/card-feature");
    const { children } = harness.store.fanOut(featureId);
    const child = children[0]!;

    const { engine, calls } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);
    engine.enqueue(child.id, "plan");
    await engine.whenIdle();

    expect(calls[0]!.prompt).toContain("API streak endpoint");
    expect(calls[0]!.prompt).toContain("Streaks must survive offline sync.");
    expect(calls[0]!.prompt).toContain("POST /streaks");
    expect(stepStatus(harness, child.id, "plan")).toBe("done");
    expect(stepStatus(harness, child.id, "impl")).toBe("done");
  });

  it("fails Plan when the exchange file is missing at finalize", async () => {
    const card = queuedCard(harness);
    const engine = makeEngineWithRunner(harness, runnerWithFinalize(() => {}));

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(harness.runStore.latestForStep(card.id, "plan")?.status).toBe("failed");
    expect(
      harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" }),
    ).toBeUndefined();
    expectDiagnosticAttachment(harness, card.id);
  });

  it("fails Plan when the exchange file is empty at finalize", async () => {
    const card = queuedCard(harness);
    const engine = makeEngineWithRunner(
      harness,
      runnerWithFinalize((options) => {
        const planDir = path.join(options.worktreePath, ".jeeves");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(path.join(planDir, "plan.md"), "  \n");
      }),
    );

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(harness.runStore.latestForStep(card.id, "plan")?.error).toMatch(/empty/);
    expect(
      harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" }),
    ).toBeUndefined();
    expectDiagnosticAttachment(harness, card.id);
  });

  it("fails Plan when the exchange file has no useful content at finalize", async () => {
    const card = queuedCard(harness);
    const engine = makeEngineWithRunner(
      harness,
      runnerWithFinalize((options) => {
        const planDir = path.join(options.worktreePath, ".jeeves");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n\n## Steps\n");
      }),
    );

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(harness.runStore.latestForStep(card.id, "plan")?.error).toMatch(/useful content/);
    expect(
      harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" }),
    ).toBeUndefined();
    expectDiagnosticAttachment(harness, card.id);
  });

  it("fails Plan when the agent edits source files beyond the exchange file", async () => {
    const card = queuedCard(harness);
    const engine = makeEngineWithRunner(
      harness,
      runnerWithFinalize((options) => {
        const planDir = path.join(options.worktreePath, ".jeeves");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n\nDo the thing.\n");
        fs.writeFileSync(path.join(options.worktreePath, "hello.txt"), "oops\n");
      }),
    );

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(harness.runStore.latestForStep(card.id, "plan")?.error).toMatch(/dirty/);
    expect(
      harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" }),
    ).toBeUndefined();
    expect(fs.existsSync(path.join(harness.artifactRoot, "worktrees", card.id))).toBe(false);
    expectDiagnosticAttachment(harness, card.id);
  });

  it("fails Plan when the agent commits to the card branch", async () => {
    const card = queuedCard(harness);
    const engine = makeEngineWithRunner(
      harness,
      runnerWithFinalize(
        (options) => {
          const planDir = path.join(options.worktreePath, ".jeeves");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n\nDo the thing.\n");
        },
        () => "newcommit999",
      ),
    );

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(harness.runStore.latestForStep(card.id, "plan")?.error).toMatch(/commits/);
    expect(
      harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" }),
    ).toBeUndefined();
    expectDiagnosticAttachment(harness, card.id);
  });

  it("moves Plan to needs-user with a failed run when the agent errors", async () => {
    const card = queuedCard(harness);
    const { engine } = makeEngine(harness, [{ error: new Error("sdk exploded") }]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    const run = harness.runStore.latestForStep(card.id, "plan");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("sdk exploded");
  });

  it("treats a cancelled run as failed", async () => {
    const card = queuedCard(harness);
    const { engine } = makeEngine(harness, [
      {
        events: [
          { type: "log", line: "working…" },
          { type: "result", status: "cancelled" },
        ],
      },
    ]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    const run = harness.runStore.latestForStep(card.id, "plan");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/cancel/i);
  });

  it("runs one card at a time — second stays queued until the first finishes", async () => {
    const first = queuedCard(harness, "First");
    const second = queuedCard(harness, "Second");
    let release!: (events: RunEvent[]) => void;
    const gate = new Promise<RunEvent[]>((r) => (release = r));
    // Depth-first: first card finishes Implement-column steps before second Plan.
    const { engine } = makeEngine(harness, [
      { gate, finalize: "plan" },
      implementOk(),
      airevOk(),
      planOk(),
      implementOk(),
      airevOk(),
    ]);

    engine.enqueue(first.id, "plan");
    engine.enqueue(second.id, "plan");
    await tick();

    expect(stepStatus(harness, first.id, "plan")).toBe("ai-working");
    expect(stepStatus(harness, second.id, "plan")).toBe("queued");

    release(ok());
    await engine.whenIdle();

    expect(stepStatus(harness, first.id, "plan")).toBe("done");
    expect(stepStatus(harness, second.id, "plan")).toBe("done");
    expect(stepStatus(harness, first.id, "impl")).toBe("done");
    expect(stepStatus(harness, second.id, "impl")).toBe("done");
  });

  it("runs unblocked siblings depth-first: child 1 Implement-column before child 2 Plan", async () => {
    const feature = harness.store.createCard(
      harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id,
    );
    harness.store.updateCard(feature.id, { title: "Feature" });
    const featureId = harness.store.decideKind(feature.id, "feature").card.id;
    harness.store.handOffGrillToSpec(featureId);
    harness.store.handOffSpecToTasks(featureId);
    harness.artifactStore.appendTasksDraft(featureId, 0, {
      tasks: [
        { id: "a", title: "First", description: "", dependsOn: [] },
        { id: "b", title: "Second", description: "", dependsOn: [] },
      ],
    });
    harness.store.setCardBranch(featureId, "jeeves/card-feature");
    const { children } = harness.store.fanOut(featureId);
    const [child1, child2] = children;

    // Scripts match depth-first consumption (fails under plans-first FIFO).
    const { engine } = makeEngine(harness, [
      planOk(),
      implementOk(),
      airevOk(),
      planOk(),
      implementOk(),
      airevOk(),
    ]);
    engine.enqueue(child1!.id, "plan");
    engine.enqueue(child2!.id, "plan");
    await engine.whenIdle();

    const order = harness.db
      .select()
      .from(runs)
      .orderBy(asc(runs.startedAt))
      .all()
      .map((r) => `${r.cardId}:${r.stepKey}`);

    const child1Pipeline = order.filter((id) => id.startsWith(`${child1!.id}:`));
    expect(child1Pipeline).toEqual([
      `${child1!.id}:plan`,
      `${child1!.id}:impl`,
      `${child1!.id}:airev`,
      `${child1!.id}:prepeval`,
    ]);
    const child2PlanIdx = order.indexOf(`${child2!.id}:plan`);
    const child1PrepIdx = order.indexOf(`${child1!.id}:prepeval`);
    expect(child2PlanIdx).toBeGreaterThan(child1PrepIdx);
  });

  it("skips blocked children even when incorrectly marked queued", async () => {
    const feature = harness.store.createCard(
      harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id,
    );
    harness.store.updateCard(feature.id, { title: "Feature" });
    const featureId = harness.store.decideKind(feature.id, "feature").card.id;
    harness.store.handOffGrillToSpec(featureId);
    harness.store.handOffSpecToTasks(featureId);
    harness.artifactStore.appendTasksDraft(featureId, 0, {
      tasks: [
        { id: "a", title: "API", description: "", dependsOn: [] },
        { id: "b", title: "UI", description: "", dependsOn: ["a"] },
      ],
    });
    harness.store.setCardBranch(featureId, "jeeves/card-feature");
    const { children } = harness.store.fanOut(featureId);
    const blocked = children[1]!;
    harness.store.setStepStatus(blocked.id, "plan", "queued");

    const { engine, calls } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);
    engine.enqueue(children[0]!.id, "plan");
    engine.enqueue(blocked.id, "plan");
    await engine.whenIdle();

    expect(stepStatus(harness, blocked.id, "plan")).toBe("queued");
    expect(
      harness.runStore.listForCard(blocked.id),
    ).toHaveLength(0);
    expect(calls.every((c) => !c.options.worktreePath.endsWith(blocked.id))).toBe(
      true,
    );
  });

  it("emits card.updated, run.log, and run.finished to subscribers", async () => {
    const card = queuedCard(harness);
    const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();

    const planRun = harness.runStore.listForCard(card.id).find((r) => r.stepKey === "plan")!;
    const planEvents = harness.received.filter(
      (e) =>
        (e.type === "run.log" || e.type === "run.finished") &&
        "runId" in e &&
        e.runId === planRun.id,
    );
    const types = harness.received
      .filter(
        (e) =>
          e.type === "card.updated" ||
          ((e.type === "run.log" || e.type === "run.finished") &&
            "runId" in e &&
            e.runId === planRun.id),
      )
      .map((e) => e.type);
    // Plan run: ai-working update, log, finished, done update — Implement adds more after.
    expect(types.slice(0, 4)).toEqual([
      "card.updated",
      "run.log",
      "run.finished",
      "card.updated",
    ]);
    const log = planEvents.find((e) => e.type === "run.log");
    expect(log).toMatchObject({ runId: planRun.id, cardId: card.id, line: "working…" });
    const finished = planEvents.find((e) => e.type === "run.finished");
    expect(finished).toMatchObject({
      runId: planRun.id,
      cardId: card.id,
      status: "succeeded",
    });
  });

  describe("boot", () => {
    it("fails orphaned running runs and moves their steps to needs-user", async () => {
      const card = queuedCard(harness);
      harness.store.setStepStatus(card.id, "plan", "ai-working");
      const orphan = harness.runStore.create({
        cardId: card.id,
        stepKey: "plan",
        skill: "plan-implementation",
        logPath: "",
      });
      const logPath = harness.artifactStore.liveLogPath(card.id, 0, orphan.id);
      fs.writeFileSync(logPath, "orphan partial log\n");
      harness.runStore.setLogPath(orphan.id, logPath);
      const { engine, calls } = makeEngine(harness, []);

      engine.boot();
      await engine.whenIdle();

      expect(harness.runStore.get(orphan.id)?.status).toBe("failed");
      expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "plan",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).toContain("orphan partial log");
      expect(calls).toHaveLength(0);
    });

    it("re-enqueues steps left queued by a restart", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.boot();
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "plan")).toBe("done");
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
    });

    it("rebuilds depth-first order from the DB (not plans-first FIFO)", async () => {
      const feature = harness.store.createCard(
        harness.store.ensureDefaultProject("jeeves", "C:/target-repo").id,
      );
      harness.store.updateCard(feature.id, { title: "Feature" });
      const featureId = harness.store.decideKind(feature.id, "feature").card.id;
      harness.store.handOffGrillToSpec(featureId);
      harness.store.handOffSpecToTasks(featureId);
      harness.artifactStore.appendTasksDraft(featureId, 0, {
        tasks: [
          { id: "a", title: "First", description: "", dependsOn: [] },
          { id: "b", title: "Second", description: "", dependsOn: [] },
        ],
      });
      harness.store.setCardBranch(featureId, "jeeves/card-feature");
      const { children } = harness.store.fanOut(featureId);
      const [child1, child2] = children;

      // Simulate restart mid-pipeline: child 1 Implement queued, child 2 Plan queued.
      harness.store.setStepStatus(child1!.id, "plan", "done");
      harness.store.setStepStatus(child1!.id, "impl", "queued");
      harness.store.setCardBranch(child1!.id, `jeeves/card-${child1!.id}`);

      const { engine } = makeEngine(harness, [
        implementOk(),
        airevOk(),
        planOk(),
        implementOk(),
        airevOk(),
      ]);
      engine.boot();
      await engine.whenIdle();

      const order = harness.db
        .select()
        .from(runs)
        .orderBy(asc(runs.startedAt))
        .all()
        .map((r) => `${r.cardId}:${r.stepKey}`);

      expect(order.indexOf(`${child1!.id}:impl`)).toBeLessThan(
        order.indexOf(`${child2!.id}:plan`),
      );
      expect(order.indexOf(`${child1!.id}:airev`)).toBeLessThan(
        order.indexOf(`${child2!.id}:plan`),
      );
    });
  });

  it("stop() aborts the in-flight run, failing it to needs-user", async () => {
    const card = queuedCard(harness);
    const gate: Promise<RunEvent[]> = new Promise(() => {});
    const { engine } = makeEngine(harness, [{ gate }]);

    engine.enqueue(card.id, "plan");
    await tick();
    expect(stepStatus(harness, card.id, "plan")).toBe("ai-working");

    await engine.stop();

    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
    expect(harness.runStore.latestForStep(card.id, "plan")?.status).toBe("failed");
  });

  it("retry re-queues a failed step and starts a fresh run row", async () => {
    const card = queuedCard(harness);
    const { engine } = makeEngine(harness, [
      { error: new Error("first attempt died") },
      planOk(),
      implementOk(),
      airevOk(),
    ]);

    engine.enqueue(card.id, "plan");
    await engine.whenIdle();
    expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");

    harness.received.length = 0;
    const retried = engine.retry(card.id, "plan");
    expect(retried.steps.find((s) => s.key === "plan")?.status).toBe("queued");
    expect(harness.received[0]).toEqual(
      expect.objectContaining({
        type: "card.updated",
        card: expect.objectContaining({
          id: card.id,
          steps: expect.arrayContaining([
            expect.objectContaining({ key: "plan", status: "queued" }),
          ]),
        }),
      }),
    );
    await engine.whenIdle();

    expect(stepStatus(harness, card.id, "plan")).toBe("done");
    expect(stepStatus(harness, card.id, "impl")).toBe("done");
    const runsForCard = harness.runStore.listForCard(card.id);
    expect(runsForCard).toHaveLength(5);
    expect(runsForCard.filter((r) => r.stepKey === "plan").map((r) => r.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(runsForCard.find((r) => r.stepKey === "impl")?.status).toBe("succeeded");
    expect(runsForCard.find((r) => r.stepKey === "airev")?.status).toBe("succeeded");
    expect(runsForCard.find((r) => r.stepKey === "prepeval")?.status).toBe("succeeded");
  });

  it("rejects retry when the step has no failed run", () => {
    const card = queuedCard(harness);
    const { engine } = makeEngine(harness, []);
    expect(() => engine.retry(card.id, "plan")).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => engine.retry("missing", "plan")).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  describe("retry from recorded base_sha (slice 4D)", () => {
    function worktreesWithAdvancingMain(root: string) {
      let resolveCount = 0;
      const createCalls: Array<{ baseSha: string; worktreePath: string }> = [];
      const base = fakeWorktrees(root);
      return {
        createCalls,
        worktrees: {
          ...base,
          async resolveRef() {
            resolveCount++;
            return resolveCount === 1 ? "sha-v1" : "sha-v2-advanced-main";
          },
          async createFrom(_branch: string, baseSha: string, worktreePath: string) {
            createCalls.push({ baseSha, worktreePath });
            await base.createFrom(_branch, baseSha, worktreePath);
          },
        } satisfies WorktreeLifecycle,
      };
    }

    it("records base_sha on the first run and replays it on retry without re-resolving main", async () => {
      const card = queuedCard(harness);
      const { worktrees, createCalls } = worktreesWithAdvancingMain(harness.artifactRoot);
      const { runner, calls } = fakeRunner([
        { error: new Error("first attempt died") },
        planOk(),
        implementOk(),
        airevOk(),
      ]);
      const engine = makeEngineWithRunner(harness, runner, worktrees);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const failedRun = harness.runStore.listForCard(card.id).find((r) => r.status === "failed");
      expect(failedRun?.baseSha).toBe("sha-v1");
      expect(createCalls[0].baseSha).toBe("sha-v1");

      engine.retry(card.id, "plan");
      await engine.whenIdle();

      expect(createCalls).toHaveLength(2);
      expect(createCalls[1].baseSha).toBe("sha-v1");
      expect(calls[1].options.baseSha).toBe("sha-v1");
      const succeededRun = harness.runStore.latestForStep(card.id, "plan");
      expect(succeededRun?.baseSha).toBe("sha-v1");
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
    });

    it("creates a fresh worktree on retry without contamination from the failed attempt", async () => {
      const card = queuedCard(harness);
      const createCalls: Array<{ worktreePath: string; hadContamination: boolean }> = [];
      const worktrees: WorktreeLifecycle = {
        ...fakeWorktrees(harness.artifactRoot),
        async createFrom(_branch, _baseSha, worktreePath) {
          const contaminated = fs.existsSync(path.join(worktreePath, "contamination.txt"));
          createCalls.push({ worktreePath, hadContamination: contaminated });
          fs.mkdirSync(worktreePath, { recursive: true });
        },
      };
      let attempt = 0;
      const runner: AgentRunner = {
        async *run(prompt, options) {
          attempt++;
          if (attempt === 1) {
            fs.writeFileSync(
              path.join(options.worktreePath, "contamination.txt"),
              "left by failed agent\n",
            );
            throw new Error("agent left a mess");
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
          const planDir = path.join(options.worktreePath, ".jeeves");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n\nClean retry.\n");
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
      const engine = makeEngineWithRunner(harness, runner, worktrees);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();
      engine.retry(card.id, "plan");
      await engine.whenIdle();

      expect(createCalls).toHaveLength(2);
      expect(createCalls[1].hadContamination).toBe(false);
      expect(stepStatus(harness, card.id, "plan")).toBe("done");
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
      expect(
        fs.existsSync(path.join(createCalls[1].worktreePath, "contamination.txt")),
      ).toBe(false);
    });

    it("preserves prior failed artifacts and latest lookup returns the newest success", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [
        { error: new Error("first attempt died") },
        planOk(),
        implementOk(),
        airevOk(),
      ]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();
      const failedRunlog = harness.artifactStore.latest(card.id, {
        stepKey: "plan",
        round: 0,
        kind: "runlog",
      });
      const failedAttachment = harness.artifactStore.latest(card.id, {
        stepKey: "plan",
        round: 0,
        kind: "attachment",
      });
      expect(failedRunlog).toBeDefined();
      expect(failedAttachment).toBeDefined();

      engine.retry(card.id, "plan");
      await engine.whenIdle();

      const runlogs = harness.artifactStore
        .list(card.id)
        .filter((a) => a.kind === "runlog" && a.stepKey === "plan");
      const plans = harness.artifactStore
        .list(card.id)
        .filter((a) => a.kind === "plan" && a.stepKey === "plan");
      const attachments = harness.artifactStore
        .list(card.id)
        .filter((a) => a.kind === "attachment" && a.stepKey === "plan");

      expect(runlogs).toHaveLength(2);
      expect(attachments).toHaveLength(1);
      expect(plans).toHaveLength(1);
      expect(harness.artifactStore.readContent(plans[0])).toContain("Tracer plan.");
      expect(
        harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" })?.id,
      ).toBe(plans[0].id);
      expect(harness.artifactStore.readBody(failedRunlog!)).toBeDefined();
    });

    it("creates a plan artifact on retry success after a dirty first attempt", async () => {
      const card = queuedCard(harness);
      let attempt = 0;
      const runner: AgentRunner = {
        async *run(prompt, options) {
          attempt++;
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
          const planDir = path.join(options.worktreePath, ".jeeves");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(
            path.join(planDir, "plan.md"),
            attempt === 1 ? "# Plan\n\nDirty first attempt.\n" : "# Plan\n\nClean retry plan.\n",
          );
          if (attempt === 1) {
            fs.writeFileSync(path.join(options.worktreePath, "oops.txt"), "dirty\n");
          }
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
      expect(stepStatus(harness, card.id, "plan")).toBe("needs-user");
      expect(
        harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "plan" }),
      ).toBeUndefined();

      engine.retry(card.id, "plan");
      await engine.whenIdle();

      const plans = harness.artifactStore
        .list(card.id)
        .filter((a) => a.kind === "plan" && a.stepKey === "plan");
      expect(plans).toHaveLength(1);
      const latest = harness.artifactStore.latest(card.id, {
        stepKey: "plan",
        round: 0,
        kind: "plan",
      });
      expect(harness.artifactStore.readContent(latest!)).toContain("Clean retry plan.");
      expect(
        harness.artifactStore.list(card.id).filter((a) => a.kind === "runlog" && a.stepKey === "plan"),
      ).toHaveLength(2);
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
    });

    it("replays base_sha after server restart when the step was left queued for retry", async () => {
      const card = queuedCard(harness);
      const { worktrees, createCalls } = worktreesWithAdvancingMain(harness.artifactRoot);
      const engine1 = makeEngineWithRunner(
        harness,
        fakeRunner([{ error: new Error("first attempt died") }]).runner,
        worktrees,
      );

      engine1.enqueue(card.id, "plan");
      await engine1.whenIdle();
      expect(harness.runStore.latestForStep(card.id, "plan")?.baseSha).toBe("sha-v1");

      harness.store.setStepStatus(card.id, "plan", "queued");
      const engine2 = makeEngineWithRunner(
        harness,
        fakeRunner([planOk(), implementOk(), airevOk()]).runner,
        worktrees,
      );
      engine2.boot();
      await engine2.whenIdle();

      expect(createCalls.at(-1)?.baseSha).toBe("sha-v1");
    });
  });

  describe("run log freeze", () => {
    it("does not index a runlog artifact while the run is still in flight", async () => {
      const card = queuedCard(harness);
      let release!: (events: RunEvent[]) => void;
      const gate = new Promise<RunEvent[]>((r) => (release = r));
      const { engine } = makeEngine(harness, [{ gate, finalize: "plan" }, implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await tick();

      expect(stepStatus(harness, card.id, "plan")).toBe("ai-working");
      expect(
        harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "runlog" }),
      ).toBeUndefined();

      release(ok());
      await engine.whenIdle();
    });

    it("freezes the final log as a runlog artifact after a successful run", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "plan",
        round: 0,
        kind: "runlog",
      });
      expect(runlog).toBeDefined();
      expect(harness.artifactStore.readBody(runlog!)).toContain("working…");
      expect(runlog!.path).toMatch(new RegExp(`^cards/${card.id}/0/runlog/.+\\.log$`));
    });

    it("freezes the final log as a runlog artifact after a failed run", async () => {
      const card = queuedCard(harness);
      const runnerWithLogThenError: AgentRunner = {
        async *run(_promptFile, options) {
          yield { type: "log", line: "partial output" };
          fs.appendFileSync(options.logPath, "partial output\n");
          throw new Error("sdk exploded");
        },
      };
      const engine = makeEngineWithRunner(harness, runnerWithLogThenError);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "plan",
        round: 0,
        kind: "runlog",
      });
      expect(runlog).toBeDefined();
      expect(harness.artifactStore.readBody(runlog!)).toContain("partial output");
      expect(runlog!.gitSha).toBeNull();
    });

    it("does not index a runlog while the step is still queued", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);
      expect(harness.runStore.latestForStep(card.id, "plan")).toBeUndefined();
      expect(
        harness.artifactStore.latest(card.id, { stepKey: "plan", round: 0, kind: "runlog" }),
      ).toBeUndefined();

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();
    });
  });

});
