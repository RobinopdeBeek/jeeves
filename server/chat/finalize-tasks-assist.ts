import fs from "node:fs";
import path from "node:path";
import {
  ArtifactStoreError,
  type ArtifactStore,
} from "../artifacts/store.js";
import type { TasksDraft } from "../artifacts/tasks-draft.js";
import { projectStoreExchangePath } from "../project-store.js";

export type TasksAssistTurnResult =
  | { kind: "qa" }
  | { kind: "revision"; draft: TasksDraft; versionCount: number };

/**
 * After a Tasks side-chat turn: classify by exchange presence.
 * Missing → Q&A (tip unchanged). Present → harvest (Zod + preserve tip ids),
 * append a new tasks-draft version.
 */
export function finalizeTasksAssistTurn(deps: {
  artifacts: ArtifactStore;
  storeRoot: string;
  cardId: string;
  round?: number;
}): TasksAssistTurnResult {
  const round = deps.round ?? 0;
  const exchangePath = projectStoreExchangePath(deps.cardId, "tasks-draft.json");
  const abs = path.resolve(deps.storeRoot, exchangePath);
  if (!fs.existsSync(abs)) {
    return { kind: "qa" };
  }

  try {
    deps.artifacts.harvest(
      deps.storeRoot,
      [{ exchangePath, kind: "tasks-draft", stepKey: "tasks" }],
      {
        cardId: deps.cardId,
        round,
        sourceSkill: "to-tasks-revise",
        preserveTasksDraftIds: true,
      },
    );
  } catch (err) {
    // Drop a bad exchange so the next Q&A turn is not treated as a revise.
    fs.rmSync(abs, { force: true });
    throw err instanceof ArtifactStoreError
      ? err
      : new ArtifactStoreError(err instanceof Error ? err.message : String(err));
  }

  return {
    kind: "revision",
    draft: deps.artifacts.readTasksDraftTip(deps.cardId, round),
    versionCount: deps.artifacts.tasksDraftVersionCount(deps.cardId, round),
  };
}
