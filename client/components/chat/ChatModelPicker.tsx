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

/** Project Chat composer control — lists CLI models and pins one per thread. */
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
      try {
        const { models: listed } = await api.listModels();
        if (!cancelled) {
          setModels(listed);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not list models");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = model ?? DEFAULT_VALUE;
  const options = ensurePinnedOption(models, model);

  return (
    <Select
      value={value}
      disabled={disabled || loading || saving || Boolean(error)}
      onValueChange={(next) => {
        const selected = next === DEFAULT_VALUE ? null : next;
        if (selected === model) return;
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
          <SelectItem value={DEFAULT_VALUE}>Default (CLI)</SelectItem>
          {options.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.displayName}
              {m.current ? " · current" : ""}
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
      displayName: pinned,
      current: false,
      default: false,
    },
    ...models,
  ];
}
