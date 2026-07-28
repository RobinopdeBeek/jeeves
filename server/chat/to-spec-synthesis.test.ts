import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import { projectStoreExchangePath } from "../project-store.js";
import { MockAcpProcess, viWaitFor } from "../ws/mock-acp-process.js";
import { createSynthesizeSpec, SpecSynthesisError } from "./to-spec-synthesis.js";

describe("createSynthesizeSpec", () => {
  let db: Db;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let cardId: string;
  const promptsRoot = path.resolve(import.meta.dirname, "../../prompts");

  beforeEach(() => {
    db = openDb(":memory:");
    const store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-synth-art-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-synth-repo-"));
    fs.mkdirSync(path.join(repoPath, ".jeeves", "exchange"), { recursive: true });
    const project = store.ensureDefaultProject("jeeves", repoPath);
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Pantry" });
    cardId = store.decideKind(card.id, "feature").card.id;
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("runs headless ACP with grill-session prompt and harvests exchange into kind:spec", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-synth");

    const synthesize = createSynthesizeSpec({
      spawn: () => process,
      artifacts,
    });

    const run = synthesize({
      cardId,
      repoPath,
      grillSession: "## Q1: Scope?\n**A:** Add item only.",
      cardTitle: "Pantry",
      cardDescription: "Track expiry.",
      promptsRoot,
    });

    await viWaitFor(() => process.prompts().length === 1);
    const prompt = process.prompts()[0]!.prompt as Array<{ text: string }>;
    expect(prompt[0]!.text).toContain("## Q1: Scope?");
    expect(prompt[0]!.text).toContain(projectStoreExchangePath(cardId, "spec.md"));
    expect(prompt[0]!.text).not.toMatch(/User:\n/);

    const exchangeAbs = path.join(
      repoPath,
      ".jeeves",
      projectStoreExchangePath(cardId, "spec.md"),
    );
    fs.mkdirSync(path.dirname(exchangeAbs), { recursive: true });
    fs.writeFileSync(exchangeAbs, "# Spec\n\nFrom headless ACP.\n");

    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await run;

    const spec = artifacts.latest(cardId, { stepKey: "spec", round: 0, kind: "spec" });
    expect(spec).toBeTruthy();
    expect(artifacts.readBody(spec!)).toContain("From headless ACP");
    expect(fs.existsSync(exchangeAbs)).toBe(false);
    expect(process.killed).toBe(true);
  });

  it("fails closed when the exchange file is missing after ACP completes", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-missing");

    const synthesize = createSynthesizeSpec({
      spawn: () => process,
      artifacts,
    });

    const run = synthesize({
      cardId,
      repoPath,
      grillSession: "## Q1: Scope?\n**A:** Add item only.",
      cardTitle: "Pantry",
      cardDescription: "",
      promptsRoot,
    });

    await viWaitFor(() => process.prompts().length === 1);
    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await expect(run).rejects.toBeInstanceOf(SpecSynthesisError);
    expect(
      artifacts.latest(cardId, { stepKey: "spec", round: 0, kind: "spec" }),
    ).toBeUndefined();
  });
});
