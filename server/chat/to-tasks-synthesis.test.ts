import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import { projectStoreExchangePath } from "../project-store.js";
import { MockAcpProcess, viWaitFor } from "../ws/mock-acp-process.js";
import {
  createSynthesizeTasksDraft,
  TasksDraftSynthesisError,
} from "./to-tasks-synthesis.js";

const VALID_EXCHANGE = JSON.stringify({
  tasks: [
    {
      title: "Add expiry column",
      description: "Schema + migration.",
      depends_on: [],
    },
    {
      title: "Show expiry in UI",
      description: "List view.",
      depends_on: [0],
    },
  ],
});

const INVALID_EXCHANGE = JSON.stringify({
  tasks: [{ title: "", description: "bad", depends_on: [] }],
});

describe("createSynthesizeTasksDraft", () => {
  let db: Db;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let cardId: string;
  const promptsRoot = path.resolve(import.meta.dirname, "../../prompts");

  beforeEach(() => {
    db = openDb(":memory:");
    const store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-tasks-synth-art-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-tasks-synth-repo-"));
    fs.mkdirSync(path.join(repoPath, ".jeeves", "exchange"), { recursive: true });
    const project = store.ensureDefaultProject("jeeves", repoPath);
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Pantry" });
    cardId = store.decideKind(card.id, "feature").card.id;
    store.handOffGrillToSpec(cardId);
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function exchangeAbs(): string {
    return path.join(
      repoPath,
      ".jeeves",
      projectStoreExchangePath(cardId, "tasks-draft.json"),
    );
  }

  it("runs headless ACP and harvests exchange into first tasks-draft tip with stable ids", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-tasks");

    const synthesize = createSynthesizeTasksDraft({
      spawn: () => process,
      artifacts,
    });

    const run = synthesize({
      cardId,
      repoPath,
      spec: "# Spec\n\nTrack expiry.\n",
      grillSession: "## Q1: Scope?\n**A:** Add item only.",
      cardTitle: "Pantry",
      cardDescription: "Track expiry.",
      promptsRoot,
    });

    await viWaitFor(() => process.prompts().length === 1);
    const prompt = process.prompts()[0]!.prompt as Array<{ text: string }>;
    expect(prompt[0]!.text).toContain("Track expiry");
    expect(prompt[0]!.text).toContain("## Q1: Scope?");
    expect(prompt[0]!.text).toContain(
      projectStoreExchangePath(cardId, "tasks-draft.json"),
    );

    const abs = exchangeAbs();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, VALID_EXCHANGE);

    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await run;

    const tip = artifacts.readTasksDraftTip(cardId, 0);
    expect(tip.tasks).toHaveLength(2);
    expect(tip.tasks[0]!.title).toBe("Add expiry column");
    expect(tip.tasks[0]!.id.length).toBeGreaterThan(0);
    expect(tip.tasks[1]!.dependsOn).toEqual([tip.tasks[0]!.id]);
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(1);
    expect(fs.existsSync(abs)).toBe(false);
    expect(process.killed).toBe(true);
  });

  it("retries once with Zod error injected when exchange JSON is invalid", async () => {
    let spawnCount = 0;
    const processes: MockAcpProcess[] = [];

    const synthesize = createSynthesizeTasksDraft({
      spawn: () => {
        spawnCount += 1;
        const process = new MockAcpProcess();
        process.autoHandshake(`sess-retry-${spawnCount}`);
        processes.push(process);
        return process;
      },
      artifacts,
    });

    const run = synthesize({
      cardId,
      repoPath,
      spec: "# Spec\n\nBody.\n",
      grillSession: "## Q1\n**A:** Yes.",
      cardTitle: "Pantry",
      cardDescription: "",
      promptsRoot,
    });

    await viWaitFor(() => processes[0] && processes[0].prompts().length === 1);
    const abs = exchangeAbs();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, INVALID_EXCHANGE);
    processes[0]!.emit({
      jsonrpc: "2.0",
      id: processes[0]!.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await viWaitFor(() => processes[1] && processes[1].prompts().length === 1);
    const retryPrompt = processes[1]!.prompts()[0]!.prompt as Array<{ text: string }>;
    expect(retryPrompt[0]!.text).toMatch(/title must be non-empty/i);
    expect(retryPrompt[0]!.text).toContain(
      projectStoreExchangePath(cardId, "tasks-draft.json"),
    );

    fs.writeFileSync(abs, VALID_EXCHANGE);
    processes[1]!.emit({
      jsonrpc: "2.0",
      id: processes[1]!.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await run;

    expect(spawnCount).toBe(2);
    expect(artifacts.readTasksDraftTip(cardId, 0).tasks).toHaveLength(2);
  });

  it("fails closed when exchange is missing after ACP completes", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-missing");

    const synthesize = createSynthesizeTasksDraft({
      spawn: () => process,
      artifacts,
    });

    const run = synthesize({
      cardId,
      repoPath,
      spec: "# Spec\n\nBody.\n",
      grillSession: "",
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

    await expect(run).rejects.toBeInstanceOf(TasksDraftSynthesisError);
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(0);
  });

  it("fails closed when Zod still fails after one retry", async () => {
    let spawnCount = 0;
    const processes: MockAcpProcess[] = [];

    const synthesize = createSynthesizeTasksDraft({
      spawn: () => {
        spawnCount += 1;
        const process = new MockAcpProcess();
        process.autoHandshake(`sess-fail-${spawnCount}`);
        processes.push(process);
        return process;
      },
      artifacts,
    });

    const run = synthesize({
      cardId,
      repoPath,
      spec: "# Spec\n\nBody.\n",
      grillSession: "",
      cardTitle: "Pantry",
      cardDescription: "",
      promptsRoot,
    });

    await viWaitFor(() => processes[0] && processes[0].prompts().length === 1);
    const abs = exchangeAbs();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, INVALID_EXCHANGE);
    processes[0]!.emit({
      jsonrpc: "2.0",
      id: processes[0]!.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await viWaitFor(() => processes[1] && processes[1].prompts().length === 1);
    fs.writeFileSync(abs, INVALID_EXCHANGE);
    processes[1]!.emit({
      jsonrpc: "2.0",
      id: processes[1]!.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await expect(run).rejects.toBeInstanceOf(TasksDraftSynthesisError);
    expect(spawnCount).toBe(2);
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(0);
  });
});
