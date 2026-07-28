import fs from "node:fs";
import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import { projectStoreExchangePath } from "../project-store.js";

export type SpecAssistTurnResult =
  | { kind: "qa" }
  | { kind: "revision"; markdown: string };

/**
 * After a Spec side-chat turn: classify by exchange presence.
 * Missing → Q&A (editor unchanged). Present → harvest full Spec revision.
 */
export function finalizeSpecAssistTurn(deps: {
  artifacts: ArtifactStore;
  storeRoot: string;
  cardId: string;
}): SpecAssistTurnResult {
  const exchangePath = projectStoreExchangePath(deps.cardId, "spec.md");
  const abs = path.resolve(deps.storeRoot, exchangePath);
  if (!fs.existsSync(abs)) {
    return { kind: "qa" };
  }

  const [harvested] = deps.artifacts.harvest(
    deps.storeRoot,
    [{ exchangePath, kind: "spec", stepKey: "spec" }],
    { cardId: deps.cardId, round: 0, sourceSkill: "spec-assist" },
  );
  return {
    kind: "revision",
    markdown: deps.artifacts.readBody(harvested!),
  };
}
