import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { StepPanelProps } from "./step-panel-types";
import { SpecEditor } from "./spec/SpecEditor";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Spec authoring surface: MDXEditor + side-chat slot (assist arrives later).
 * Grill session is Spec's upstream input ([ADR 0012](../../docs/adr/0012-grill-session-qa-handoff.md)).
 */
export function StepSpec({ card, onSpecBodyChange }: StepPanelProps) {
  const specStep = card.steps.find((s) => s.key === "spec");
  const readOnly = specStep?.status === "done";
  const [markdown, setMarkdown] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [grillSession, setGrillSession] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);

    void (async () => {
      try {
        const [spec, grill] = await Promise.all([
          api
            .getLatestArtifact(card.id, { stepKey: "spec", round: 0, kind: "spec" })
            .then((a) => a.content)
            .catch(() => ""),
          api
            .getLatestArtifact(card.id, { stepKey: "grill", round: 0, kind: "grill" })
            .then((a) => a.content)
            .catch(() => null),
        ]);
        if (cancelled) return;
        setMarkdown(spec);
        lastSavedRef.current = spec;
        onSpecBodyChange?.(spec);
        setGrillSession(grill);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [card.id, onSpecBodyChange]);

  function handleChange(next: string) {
    setMarkdown(next);
    onSpecBodyChange?.(next);
    if (readOnly) return;
    if (next === lastSavedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          await api.putSpec(card.id, next);
          lastSavedRef.current = next;
          setSaveError(null);
        } catch (err) {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
      })();
    }, SAVE_DEBOUNCE_MS);
  }

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading Spec…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SpecEditor
            key={card.id}
            markdown={markdown}
            readOnly={readOnly}
            onChange={handleChange}
          />
        </div>
        {!readOnly ? (
          <aside className="flex max-h-80 min-h-0 w-full shrink-0 flex-col rounded-md border md:max-h-none md:w-80">
            <div className="border-b px-3 py-2 text-sm font-medium">Spec assist</div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 text-sm text-muted-foreground">
              <p>
                Side-chat arrives in a later slice. Drafting input is the Grill session
                artifact (not the raw transcript).
              </p>
              {grillSession ? (
                <p className="text-xs">Grill session loaded ({grillSession.length} chars).</p>
              ) : (
                <p className="text-xs">No Grill session artifact found for this card.</p>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
