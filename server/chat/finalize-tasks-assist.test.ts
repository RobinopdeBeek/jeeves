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
import { finalizeTasksAssistTurn } from "./finalize-tasks-assist.js";

describe("finalizeTasksAssistTurn", () => {
  let db: Db;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let storeRoot: string;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    const store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-finalize-tasks-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-finalize-tasks-repo-"));
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

  it("treats a missing exchange file as Q&A (tip unchanged)", () => {
    artifacts.appendTasksDraft(
      cardId,
      0,
      {
        tasks: [
          { id: "a", title: "API", description: "", dependsOn: [] },
        ],
      },
      "human",
    );

    const result = finalizeTasksAssistTurn({
      artifacts,
      storeRoot,
      cardId,
    });
    expect(result).toEqual({ kind: "qa" });
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(1);
    expect(artifacts.readTasksDraftTip(cardId, 0).tasks[0]!.id).toBe("a");
  });

  it("harvests exchange into a new tip version preserving ids by index", () => {
    artifacts.appendTasksDraft(
      cardId,
      0,
      {
        tasks: [
          { id: "keep-a", title: "API", description: "", dependsOn: [] },
          { id: "keep-b", title: "UI", description: "", dependsOn: ["keep-a"] },
        ],
      },
      "to-draft-tasks",
    );

    const exchangePath = projectStoreExchangePath(cardId, "tasks-draft.json");
    const abs = path.join(storeRoot, exchangePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      JSON.stringify({
        tasks: [
          {
            title: "API revised",
            description: "updated",
            depends_on: [],
          },
          {
            title: "UI",
            description: "ui",
            depends_on: [0],
          },
        ],
      }),
    );

    const result = finalizeTasksAssistTurn({
      artifacts,
      storeRoot,
      cardId,
    });

    expect(result.kind).toBe("revision");
    if (result.kind !== "revision") return;
    expect(result.draft.tasks.map((t) => t.id)).toEqual(["keep-a", "keep-b"]);
    expect(result.draft.tasks[0]!.title).toBe("API revised");
    expect(fs.existsSync(abs)).toBe(false);
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(2);
  });

  it("rejects invalid exchange JSON without appending a version", () => {
    const exchangePath = projectStoreExchangePath(cardId, "tasks-draft.json");
    const abs = path.join(storeRoot, exchangePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      JSON.stringify({
        tasks: [{ title: "", description: "", depends_on: [] }],
      }),
    );

    expect(() =>
      finalizeTasksAssistTurn({ artifacts, storeRoot, cardId }),
    ).toThrow(/title/i);
    expect(artifacts.tasksDraftVersionCount(cardId, 0)).toBe(0);
    // Bad exchange is cleared so a later Q&A turn is not poisoned.
    expect(fs.existsSync(abs)).toBe(false);
  });
});
