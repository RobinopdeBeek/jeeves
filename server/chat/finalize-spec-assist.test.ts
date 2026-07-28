import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import {
  projectStoreExchangePath,
  resolveProjectStorePaths,
} from "../project-store.js";
import { finalizeSpecAssistTurn } from "./finalize-spec-assist.js";

describe("finalizeSpecAssistTurn", () => {
  let db: Db;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let storeRoot: string;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    const store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-finalize-art-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-finalize-repo-"));
    storeRoot = resolveProjectStorePaths(repoPath).storeRoot;
    fs.mkdirSync(path.join(storeRoot, "exchange"), { recursive: true });
    const project = store.ensureDefaultProject("jeeves", repoPath);
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Pantry" });
    cardId = store.decideKind(card.id, "feature").card.id;
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("treats a missing exchange file as Q&A (no harvest)", () => {
    const result = finalizeSpecAssistTurn({
      artifacts,
      storeRoot,
      cardId,
    });
    expect(result).toEqual({ kind: "qa" });
    expect(
      artifacts.latest(cardId, { stepKey: "spec", round: 0, kind: "spec" }),
    ).toBeUndefined();
  });

  it("harvests a present exchange file into a full Spec revision", () => {
    const exchangePath = projectStoreExchangePath(cardId, "spec.md");
    const abs = path.join(storeRoot, exchangePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "# Revised Spec\n\nAcceptance: fridge only.\n");

    const result = finalizeSpecAssistTurn({
      artifacts,
      storeRoot,
      cardId,
    });

    expect(result.kind).toBe("revision");
    if (result.kind !== "revision") return;
    expect(result.markdown).toContain("Acceptance: fridge only.");
    expect(fs.existsSync(abs)).toBe(false);

    const saved = artifacts.latest(cardId, {
      stepKey: "spec",
      round: 0,
      kind: "spec",
    });
    expect(saved).toBeDefined();
    expect(artifacts.readBody(saved!)).toContain("Acceptance: fridge only.");
  });
});
