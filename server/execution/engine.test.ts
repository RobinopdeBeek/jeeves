import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projects } from "../db/schema.js";
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
    // Queue after first Plan succeeds: second Plan, then first Implement.
    // After both Implements: first AI Review, then second AI Review.
    const { engine } = makeEngine(harness, [
      { gate, finalize: "plan" },
      planOk(),
      implementOk(),
      implementOk(),
      airevOk(),
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
    expect(runsForCard).toHaveLength(4);
    expect(runsForCard.filter((r) => r.stepKey === "plan").map((r) => r.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(runsForCard.find((r) => r.stepKey === "impl")?.status).toBe("succeeded");
    expect(runsForCard.find((r) => r.stepKey === "airev")?.status).toBe("succeeded");
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
      expect(resolvedRefs).toEqual(["main", branch, branch]);
      expect(createFromCalls).toEqual([{ branch, baseSha: "sha-of-main" }]);
      expect(checkoutCalls).toEqual([{ branch }, { branch }]);
      expect(harness.store.getCard(card.id)?.branch).toBe(branch);
      expect(harness.runStore.latestForStep(card.id, "plan")?.baseSha).toBe("sha-of-main");
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
      expect(stepStatus(harness, card.id, "airev")).toBe("done");
    });

    it("uses a non-main projects.default_branch as the upstream ref", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ defaultBranch: "develop" })
        .where(eq(projects.id, project.id))
        .run();
      const card = harness.store.createCard(project.id);
      harness.store.updateCard(card.id, { title: "Develop base" });
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
      expect(stepStatus(harness, card.id, "impl")).toBe("done");

      // Advance the durable tip, then re-queue Plan as a later run on the same branch.
      const branch = `jeeves/card-${card.id}`;
      tracked.tipByBranch.set(branch, "sha-after-implement");
      harness.store.setStepStatus(card.id, "plan", "queued");
      harness.store.setStepStatus(card.id, "impl", "pending");
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
      // Implement + AI Review continuations after successful Plan retry.
      expect(tracked.checkoutCalls).toEqual([
        { branch: `jeeves/card-${card.id}` },
        { branch: `jeeves/card-${card.id}` },
      ]);
      expect(tracked.resolvedRefs).toEqual([
        `jeeves/card-${card.id}`,
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
      expect(harness.runStore.latestForStep(card.id, "impl")?.skill).toBe("implement-task");
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
      expect(stepStatus(harness, card.id, "airev")).toBe("done");
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
      ]);
      expect(stepStatus(harness, card.id, "impl")).toBe("done");
      expect(stepStatus(harness, card.id, "airev")).toBe("done");
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
      expect(stepStatus(harness, card.id, "impl")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "impl")?.error).toMatch(
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

      expect(stepStatus(harness, card.id, "impl")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "impl")?.error).toMatch(/dirty/i);
    });

    it("skips verify_commands with a warning when null/empty", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "impl")).toBe("done");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "impl",
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
        .set({ verifyCommands: JSON.stringify(["false"]) })
        .where(eq(projects.id, project.id))
        .run();
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "impl")).toBe("needs-user");
      const run = harness.runStore.latestForStep(card.id, "impl");
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/verify_commands failed/i);
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "impl",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).toMatch(/verify_commands failed/i);
    });

    it("passes Implement when verify_commands succeed", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify(["true"]) })
        .where(eq(projects.id, project.id))
        .run();
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "impl")).toBe("done");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "impl",
        round: 0,
        kind: "runlog",
      });
      expect(harness.artifactStore.readBody(runlog!)).toMatch(
        /verify_commands: all commands passed/i,
      );
    });
  });

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
      expect(harness.runStore.latestForStep(card.id, "airev")?.skill).toBe("ai-review");
      expect(harness.runStore.listForCard(card.id).filter((r) => r.stepKey === "airev")).toHaveLength(
        1,
      );
    });

    it("harvests review.md and advances to Review with prepeval queued on clean review", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const review = harness.artifactStore.latest(card.id, {
        stepKey: "airev",
        round: 0,
        kind: "review",
      });
      expect(review).toBeDefined();
      expect(harness.artifactStore.readBody(review!)).toContain("Clean review");
      expect(stepStatus(harness, card.id, "airev")).toBe("done");
      expect(harness.store.getCard(card.id)?.column).toBe("review");
      expect(stepStatus(harness, card.id, "prepeval")).toBe("queued");
      expect(stepStatus(harness, card.id, "review")).toBe("pending");
    });

    it("allows zero commits on a clean review and skips host verify", async () => {
      const card = queuedCard(harness);
      const { engine: setup } = makeEngine(harness, [planOk(), implementOk()]);
      // Stop after Implement by not providing airevOk — Implement still enqueues airev,
      // which fails without a script. Reset to a clean airev queued state instead.
      setup.enqueue(card.id, "plan");
      await setup.whenIdle();

      // Leave Implement done; park AI Review as queued with a branch tip ready.
      harness.store.setStepStatus(card.id, "airev", "queued");
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify(["false"]) })
        .where(eq(projects.id, project.id))
        .run();

      const { engine } = makeEngine(harness, [airevOk()]);
      engine.enqueue(card.id, "airev");
      await engine.whenIdle();

      // Clean airev made no commits — verify_commands must not run (would fail).
      expect(stepStatus(harness, card.id, "airev")).toBe("done");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "airev",
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

      harness.store.setStepStatus(card.id, "airev", "queued");
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify(["false"]) })
        .where(eq(projects.id, project.id))
        .run();

      const { engine } = makeEngine(harness, [airevReworkOk()]);
      engine.enqueue(card.id, "airev");
      await engine.whenIdle();

      expect(stepStatus(harness, card.id, "airev")).toBe("needs-user");
      expect(harness.store.getCard(card.id)?.column).toBe("implement");
      const run = harness.runStore.latestForStep(card.id, "airev");
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/verify_commands failed/i);
    });

    it("passes AI Review with rework commits when verify_commands succeed", async () => {
      const project = harness.store.ensureDefaultProject("jeeves", "C:/target-repo");
      harness.db
        .update(projects)
        .set({ verifyCommands: JSON.stringify(["true"]) })
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

      expect(stepStatus(harness, card.id, "airev")).toBe("done");
      expect(harness.store.getCard(card.id)?.column).toBe("review");
      const runlog = harness.artifactStore.latest(card.id, {
        stepKey: "airev",
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

      expect(stepStatus(harness, card.id, "airev")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "airev")?.error).toMatch(
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

      expect(stepStatus(harness, card.id, "airev")).toBe("needs-user");
      expect(harness.runStore.latestForStep(card.id, "airev")?.error).toMatch(/dirty/i);
    });

    it("does not produce Evaluation HTML or eval artifacts", async () => {
      const card = queuedCard(harness);
      const { engine } = makeEngine(harness, [planOk(), implementOk(), airevOk()]);

      engine.enqueue(card.id, "plan");
      await engine.whenIdle();

      const kinds = harness.artifactStore.list(card.id).map((a) => a.kind);
      expect(kinds).toContain("review");
      expect(kinds).not.toContain("eval");
    });
  });
});
