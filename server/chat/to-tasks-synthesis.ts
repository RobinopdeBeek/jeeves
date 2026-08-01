import {
  AcpHeadlessError,
  type SpawnAcp,
} from "../ws/chat.js";
import { runHeadlessAcp } from "../ws/run-headless-acp.js";
import {
  buildToDraftTasksPrompt,
  buildToDraftTasksRetryPrompt,
} from "../ws/to-draft-tasks.js";
import {
  projectStoreExchangePath,
  resolveProjectStorePaths,
} from "../project-store.js";
import {
  ArtifactStoreError,
  type ArtifactStore,
} from "../artifacts/store.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_FILE = "tasks-draft.json";

export class TasksDraftSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TasksDraftSynthesisError";
  }
}

export interface SynthesizeTasksDraftInput {
  cardId: string;
  repoPath: string;
  spec: string;
  grillSession: string;
  cardTitle: string;
  cardDescription: string;
  promptsRoot: string;
}

/**
 * Headless ACP `/to-draft-tasks` + Zod validate (one auto-retry) + harvest
 * into the first `tasks-draft` tip. Fails closed before the caller advances steps.
 */
export type SynthesizeTasksDraft = (
  input: SynthesizeTasksDraftInput,
) => Promise<void>;

export function createSynthesizeTasksDraft(deps: {
  spawn: SpawnAcp;
  artifacts: ArtifactStore;
  timeoutMs?: number;
}): SynthesizeTasksDraft {
  return async (input) => {
    const exchangePath = projectStoreExchangePath(input.cardId, EXCHANGE_FILE);
    const prompt = buildToDraftTasksPrompt(
      {
        spec: input.spec,
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
      throw new TasksDraftSynthesisError(headlessMessage(e));
    }

    const storeRoot = resolveProjectStorePaths(input.repoPath).storeRoot;
    const harvestOnce = () =>
      deps.artifacts.harvest(
        storeRoot,
        [{ exchangePath, kind: "tasks-draft", stepKey: "tasks" }],
        { cardId: input.cardId, round: 0, sourceSkill: "to-draft-tasks" },
      );

    try {
      harvestOnce();
      return;
    } catch (e) {
      if (!isRetryableValidationError(e)) {
        throw new TasksDraftSynthesisError(harvestMessage(e));
      }
      const validationError = harvestMessage(e);
      try {
        await runHeadlessAcp({
          spawn: deps.spawn,
          cwd: input.repoPath,
          prompt: buildToDraftTasksRetryPrompt({
            exchangePath,
            validationError,
          }),
          permissionPolicy: "cursor-like",
          timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      } catch (retryAcpErr) {
        throw new TasksDraftSynthesisError(headlessMessage(retryAcpErr));
      }
      try {
        harvestOnce();
      } catch (retryHarvestErr) {
        throw new TasksDraftSynthesisError(harvestMessage(retryHarvestErr));
      }
    }
  };
}

function headlessMessage(e: unknown): string {
  if (e instanceof AcpHeadlessError) return e.message;
  if (e instanceof Error) return e.message;
  return "tasks-draft synthesis failed";
}

function harvestMessage(e: unknown): string {
  if (e instanceof ArtifactStoreError) return e.message;
  if (e instanceof Error) return e.message;
  return "tasks-draft harvest failed";
}

/** Missing/empty exchange is not a Zod retry — only validation failures. */
function isRetryableValidationError(e: unknown): boolean {
  if (!(e instanceof ArtifactStoreError)) return false;
  const msg = e.message;
  if (msg.startsWith("missing required exchange file:")) return false;
  if (msg.startsWith("exchange file is empty:")) return false;
  return true;
}
