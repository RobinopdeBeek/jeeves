/**
 * Model catalog for the Project Chat picker, sourced from the ACP handshake's
 * `configOptions` model selector (`session/new`) rather than `agent models`
 * stdout — same list the agent will actually accept, already ordered by its own
 * preference, and no extra `execFile`.
 *
 * The catalog is account- and CLI-version-scoped, not session-scoped, so it is
 * cached per process: whichever bridge handshakes first fills it, and every
 * later picker load is instant.
 */

import type { AcpSessionConfigOption } from "../ws/chat.js";

export interface AgentModel {
  /** ACP config option value — a variant string like `composer-2.5[fast=true]`. */
  id: string;
  displayName: string;
  /** Matches the reporting session's current model. */
  current: boolean;
  /** The agent's own automatic pick (`default[]`). */
  default: boolean;
}

/** Config value meaning "let the agent choose" (Auto). */
export const AUTO_MODEL_VALUE = "default[]";

export class ListModelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListModelsError";
  }
}

/** Bare id before the variant suffix: `composer-2.5[fast=true]` → `composer-2.5`. */
function bareModelId(value: string): string {
  const bracket = value.indexOf("[");
  return bracket === -1 ? value : value.slice(0, bracket);
}

/**
 * Resolve a stored `thread.model` onto a live config option value.
 *
 * Rows written before models moved to config options hold **bare** ids
 * (`composer-2.5`), so match those against each value's prefix. `null` (and
 * anything the account no longer offers) means Auto.
 */
export function resolveModelValue(
  stored: string | null | undefined,
  values: readonly string[],
): string | null {
  const auto = values.includes(AUTO_MODEL_VALUE) ? AUTO_MODEL_VALUE : null;
  const trimmed = stored?.trim();
  if (!trimmed) return auto;
  if (values.includes(trimmed)) return trimmed;
  return values.find((value) => bareModelId(value) === trimmed) ?? auto;
}

/** Picker rows from a `model` config option (Auto is the picker's own row). */
export function modelsFromConfigOption(
  option: AcpSessionConfigOption | null,
): AgentModel[] {
  return (option?.options ?? [])
    .filter((o) => typeof o?.value === "string" && o.value !== AUTO_MODEL_VALUE)
    .map((o) => ({
      id: o.value,
      displayName: o.name?.trim() || bareModelId(o.value),
      current: o.value === option?.currentValue,
      default: false,
    }));
}

let catalog: AgentModel[] | null = null;
let waiters: Array<(models: AgentModel[]) => void> = [];

/** Called by the session registry whenever an ACP handshake completes. */
export function recordModelCatalog(option: AcpSessionConfigOption | null): void {
  const models = modelsFromConfigOption(option);
  if (models.length === 0) return;
  catalog = models;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(models);
}

export function resetModelCatalog(): void {
  catalog = null;
  waiters = [];
}

/**
 * Models for the picker. Waits for the first handshake to land when the catalog
 * is still empty — the Chat page pre-warms a spare on load, so this is the
 * same "picker fills in a moment" wait the CLI scrape used to cost.
 */
export function listAgentModels(timeoutMs = 20_000): Promise<AgentModel[]> {
  if (catalog) return Promise.resolve(catalog);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== onCatalog);
      reject(
        new ListModelsError(
          "no agent session has started yet — model list unavailable",
        ),
      );
    }, timeoutMs);
    const onCatalog = (models: AgentModel[]) => {
      clearTimeout(timer);
      resolve(models);
    };
    waiters.push(onCatalog);
  });
}
