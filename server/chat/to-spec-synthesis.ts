import {
  AcpHeadlessError,
  type SpawnAcp,
} from "../ws/chat.js";
import { runHeadlessAcp } from "../ws/run-headless-acp.js";
import { buildToSpecPrompt } from "../ws/to-spec.js";
import {
  projectStoreExchangePath,
  resolveProjectStorePaths,
} from "../project-store.js";
import {
  ArtifactStoreError,
  type ArtifactStore,
} from "../artifacts/store.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class SpecSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecSynthesisError";
  }
}

export interface SynthesizeSpecInput {
  cardId: string;
  repoPath: string;
  grillSession: string;
  cardTitle: string;
  cardDescription: string;
  promptsRoot: string;
}

/**
 * Headless ACP `/to-spec` + harvest into durable `kind: spec`.
 * Fails closed before the caller advances steps.
 */
export type SynthesizeSpec = (input: SynthesizeSpecInput) => Promise<void>;

export function createSynthesizeSpec(deps: {
  spawn: SpawnAcp;
  artifacts: ArtifactStore;
  timeoutMs?: number;
}): SynthesizeSpec {
  return async (input) => {
    const exchangePath = projectStoreExchangePath(input.cardId, "spec.md");
    const prompt = buildToSpecPrompt(
      {
        grillSession: input.grillSession,
        cardTitle: input.cardTitle,
        cardDescription: input.cardDescription,
        exchangePath,
      },
      input.promptsRoot,
    );

    try {
      await runHeadlessAcp({
        spawn: deps.spawn,
        cwd: input.repoPath,
        prompt,
        permissionPolicy: "cursor-like",
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      const message =
        e instanceof AcpHeadlessError
          ? e.message
          : e instanceof Error
            ? e.message
            : "spec synthesis failed";
      throw new SpecSynthesisError(message);
    }

    const storeRoot = resolveProjectStorePaths(input.repoPath).storeRoot;
    try {
      deps.artifacts.harvest(
        storeRoot,
        [{ exchangePath, kind: "spec", stepKey: "spec" }],
        { cardId: input.cardId, round: 0, sourceSkill: "to-spec" },
      );
    } catch (e) {
      const message =
        e instanceof ArtifactStoreError
          ? e.message
          : e instanceof Error
            ? e.message
            : "spec harvest failed";
      throw new SpecSynthesisError(message);
    }
  };
}
