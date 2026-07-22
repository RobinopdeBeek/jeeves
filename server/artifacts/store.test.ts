import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import { ArtifactStore, ArtifactStoreError } from "./store.js";

describe("ArtifactStore", () => {
  let db: Db;
  let store: CardStore;
  let artifactRoot: string;
  let artifacts: ArtifactStore;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-artifacts-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    const projectId = store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    cardId = store.createCard(projectId).id;
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("harvests a declared plan exchange file into an indexed immutable file", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-wt-"));
    const exchangeDir = path.join(workspace, ".jeeves");
    fs.mkdirSync(exchangeDir, { recursive: true });
    fs.writeFileSync(path.join(exchangeDir, "plan.md"), "# Plan\n\nDo the thing.\n");

    const harvested = artifacts.harvest(
      workspace,
      [{ exchangePath: ".jeeves/plan.md", kind: "plan", stepKey: "plan" }],
      { cardId, round: 0, gitSha: "deadbeef", sourceSkill: "slice-3-tracer" },
    );

    expect(harvested).toHaveLength(1);
    expect(harvested[0]).toMatchObject({
      cardId,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      gitSha: "deadbeef",
    });
    expect(harvested[0].path).toMatch(new RegExp(`^cards/${cardId}/0/plan/.+\\.md$`));

    const absPath = path.join(artifactRoot, harvested[0].path);
    expect(fs.existsSync(absPath)).toBe(true);
    const body = fs.readFileSync(absPath, "utf8");
    expect(body).toContain(`card_id: ${cardId}`);
    expect(body).toContain("kind: plan");
    expect(body).toContain("# Plan");
    expect(fs.existsSync(path.join(exchangeDir, "plan.md"))).toBe(false);

    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("lists artifacts and returns the latest by step/round/kind", () => {
    artifacts.save({
      cardId,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      content: "# First plan",
      sourceSkill: "slice-3-tracer",
    });
    artifacts.save({
      cardId,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      content: "# Second plan",
      sourceSkill: "slice-3-tracer",
    });

    const listed = artifacts.list(cardId);
    expect(listed).toHaveLength(2);
    expect(listed[0].createdAt.getTime()).toBeGreaterThanOrEqual(
      listed[1].createdAt.getTime(),
    );

    const latest = artifacts.latest(cardId, { stepKey: "plan", round: 0, kind: "plan" });
    expect(latest?.id).toBe(listed[0].id);
    expect(artifacts.readContent(latest!)).toContain("# Second plan");
  });

  it("resolves live log paths under the card round folder", () => {
    const logPath = artifacts.liveLogPath(cardId, 0, "run-abc");
    expect(logPath).toBe(path.join(artifactRoot, "cards", cardId, "0", "run-run-abc.log"));
    expect(fs.existsSync(path.dirname(logPath))).toBe(true);
  });

  it("resolves serve paths only inside the card artifact folder", () => {
    const saved = artifacts.save({
      cardId,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      content: "# Plan",
      sourceSkill: "slice-3-tracer",
    });
    const servePath = artifacts.resolveServePath(cardId, saved.path);
    expect(servePath).toBe(path.join(artifactRoot, saved.path));

    expect(() => artifacts.resolveServePath(cardId, "../escape.txt")).toThrow(ArtifactStoreError);
    expect(() => artifacts.resolveServePath("other-card", saved.path)).toThrow(ArtifactStoreError);
  });

  it("throws when a required exchange file is missing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-wt-"));
    expect(() =>
      artifacts.harvest(
        workspace,
        [{ exchangePath: ".jeeves/plan.md", kind: "plan", stepKey: "plan" }],
        { cardId, round: 0, sourceSkill: "slice-3-tracer" },
      ),
    ).toThrow(/plan\.md/);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("throws when a plan exchange file is whitespace-only", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-wt-"));
    const exchangeDir = path.join(workspace, ".jeeves");
    fs.mkdirSync(exchangeDir, { recursive: true });
    fs.writeFileSync(path.join(exchangeDir, "plan.md"), "   \n\n  ");

    expect(() =>
      artifacts.harvest(
        workspace,
        [{ exchangePath: ".jeeves/plan.md", kind: "plan", stepKey: "plan" }],
        { cardId, round: 0, sourceSkill: "slice-3-tracer" },
      ),
    ).toThrow(/empty/);

    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const sampleTranscript: UIMessage[] = [
    { id: "msg-1", role: "user", parts: [{ type: "text", text: "What should we build?" }] },
    {
      id: "msg-2",
      role: "assistant",
      parts: [{ type: "text", text: "Let's start with the domain model." }],
    },
  ];

  function cardWithGrillStep(): void {
    store.updateCard(cardId, { title: "Feature" });
    store.decideKind(cardId, "feature");
  }

  it("creates a transcript artifact on first upsert and overwrites on subsequent writes", () => {
    cardWithGrillStep();
    const first = artifacts.upsertTranscript(cardId, "grill", 0, sampleTranscript);
    expect(first).toMatchObject({
      cardId,
      stepKey: "grill",
      round: 0,
      kind: "transcript",
    });
    expect(first.path).toBe(`cards/${cardId}/0/transcript/transcript.json`);

    const updatedTranscript: UIMessage[] = [
      ...sampleTranscript,
      { id: "msg-3", role: "user", parts: [{ type: "text", text: "Sounds good." }] },
    ];
    const second = artifacts.upsertTranscript(cardId, "grill", 0, updatedTranscript);

    expect(second.id).toBe(first.id);
    expect(second.path).toBe(first.path);
    expect(artifacts.list(cardId)).toHaveLength(1);

    const latest = artifacts.latest(cardId, { stepKey: "grill", round: 0, kind: "transcript" });
    expect(latest?.id).toBe(first.id);
    expect(JSON.parse(artifacts.readContent(latest!))).toEqual(updatedTranscript);
  });

  it("round-trips UIMessage[] transcript content", () => {
    cardWithGrillStep();
    artifacts.upsertTranscript(cardId, "grill", 0, sampleTranscript);
    const latest = artifacts.latest(cardId, { stepKey: "grill", round: 0, kind: "transcript" });
    expect(JSON.parse(artifacts.readContent(latest!))).toEqual(sampleTranscript);
  });

  it("rejects transcript writes when the step is done", () => {
    cardWithGrillStep();
    store.setStepStatus(cardId, "grill", "done");
    expect(() => artifacts.upsertTranscript(cardId, "grill", 0, sampleTranscript)).toThrow(
      /frozen/i,
    );
  });

  it("throws when a plan exchange file has no useful content beyond headings", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-wt-"));
    const exchangeDir = path.join(workspace, ".jeeves");
    fs.mkdirSync(exchangeDir, { recursive: true });
    fs.writeFileSync(path.join(exchangeDir, "plan.md"), "# Plan\n\n## Steps\n");

    expect(() =>
      artifacts.harvest(
        workspace,
        [{ exchangePath: ".jeeves/plan.md", kind: "plan", stepKey: "plan" }],
        { cardId, round: 0, sourceSkill: "slice-3-tracer" },
      ),
    ).toThrow(/useful content/);

    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
