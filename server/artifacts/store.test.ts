import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("harvests a declared plan sidecar into an indexed immutable file", () => {
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

  it("throws when a required exchange sidecar is missing", () => {
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
});
