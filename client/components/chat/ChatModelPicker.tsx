import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type AgentModel } from "@/lib/api";

const DEFAULT_VALUE = "__default__";
const MODEL_LIST_ATTEMPTS = 3;
const MODEL_LIST_RETRY_MS = 3000;
/** ACP config value for "let the agent choose"; the picker shows it as Auto. */
const AUTO_MODEL_VALUE = "default[]";

/**
 * Model ids are ACP config values — variant strings like
 * `composer-2.5[fast=true]`. Threads pinned before that switch stored the bare
 * id, so match those against the prefix; anything unrecognised falls back to
 * Auto rather than pinning a value the agent would reject.
 */
function resolveModelValue(
  pinned: string | null,
  models: AgentModel[],
): string | null {
  if (!pinned || pinned === AUTO_MODEL_VALUE) return null;
  if (models.some((m) => m.id === pinned)) return pinned;
  return models.find((m) => m.id.split("[")[0] === pinned)?.id ?? null;
}

/**
 * Project Chat composer control. Lists the agent's own model options and pins
 * one per thread; the switch applies to the live session, so it stays usable
 * for the whole conversation.
 */
export function ChatModelPicker({
  model,
  onModelChange,
  disabled,
}: {
  model: string | null;
  onModelChange: (model: string | null) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The catalog comes from the first ACP handshake, so an early load can
      // land before any session exists. Retry rather than disabling the picker
      // for the rest of the page's life.
      for (let attempt = 0; attempt < MODEL_LIST_ATTEMPTS; attempt++) {
        try {
          const { models: listed } = await api.listModels();
          if (cancelled) return;
          setModels(listed);
          setError(null);
          setLoading(false);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt === MODEL_LIST_ATTEMPTS - 1) {
            setError(err instanceof Error ? err.message : "Could not list models");
            setLoading(false);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, MODEL_LIST_RETRY_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved = resolveModelValue(model, models);
  // While the catalog is still loading there is nothing to resolve against, so
  // show the stored pin as-is rather than claiming the thread is on Auto.
  const provisional = resolved == null && models.length === 0 ? model : null;
  const value = resolved ?? provisional ?? DEFAULT_VALUE;
  const options = ensurePinnedOption(models, provisional);

  return (
    <Select
      value={value}
      disabled={disabled || loading || saving || Boolean(error)}
      onValueChange={(next) => {
        const selected = next === DEFAULT_VALUE ? null : next;
        if (selected === value) return;
        setSaving(true);
        void Promise.resolve(onModelChange(selected)).finally(() => {
          setSaving(false);
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Model"
        title={error ?? "Model for this Chat Thread"}
        className="max-w-48"
      >
        <SelectValue placeholder={loading ? "Loading models…" : "Model"} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectGroup>
          <SelectItem value={DEFAULT_VALUE}>Auto</SelectItem>
          {options.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.displayName}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ensurePinnedOption(
  models: AgentModel[],
  pinned: string | null,
): AgentModel[] {
  if (!pinned || models.some((m) => m.id === pinned)) return models;
  return [
    {
      id: pinned,
      displayName: pinned.split("[")[0] ?? pinned,
      current: false,
      default: false,
    },
    ...models,
  ];
}
