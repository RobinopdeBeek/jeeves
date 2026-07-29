import { useEffect, useRef, useState } from "react";
import {
  AssistLauncherFab,
  DefineAssistChat,
  DefineAssistSidePanel,
  SPEC_ASSIST_LABELS,
} from "@/components/assist/DefineAssistPanel";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StepPanelProps } from "./step-panel-types";
import { SpecEditor, type SpecEditorHandle } from "./spec/SpecEditor";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Spec authoring surface: MDXEditor + Spec assist side-chat (Grill chat stack).
 * Grill session is Spec's upstream input ([ADR 0012](../../docs/adr/0012-grill-session-qa-handoff.md)).
 */
export function StepSpec({
  card,
  registerSpecFlush,
  synthesizingTasks,
}: StepPanelProps) {
  if (synthesizingTasks) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-muted-foreground">
          Creating Tasks from Spec…
        </p>
      </div>
    );
  }

  return <LiveSpec card={card} registerSpecFlush={registerSpecFlush} />;
}

function LiveSpec({
  card,
  registerSpecFlush,
}: Pick<StepPanelProps, "card" | "registerSpecFlush">) {
  const specStep = card.steps.find((s) => s.key === "spec");
  const stepDone = specStep?.status === "done";
  const [markdown, setMarkdown] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [assistOpen, setAssistOpen] = useState(true);
  const [assistUnread, setAssistUnread] = useState(false);
  /** Remount MDXEditor when the Spec artifact is replaced (AI harvest / reload). */
  const [editorContentKey, setEditorContentKey] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const wasStreamingRef = useRef(false);
  const assistOpenRef = useRef(assistOpen);
  const markdownRef = useRef(markdown);
  const editorRef = useRef<SpecEditorHandle>(null);
  markdownRef.current = markdown;
  assistOpenRef.current = assistOpen;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);

    void (async () => {
      try {
        const spec = await api
          .getLatestArtifact(card.id, { stepKey: "spec", round: 0, kind: "spec" })
          .then((a) => a.content)
          .catch((err: unknown) => {
            // Missing Spec is empty editor; real failures surface as loadError.
            if (err instanceof Error && err.message === "not found") return "";
            throw err;
          });
        if (cancelled) return;
        setMarkdown(spec);
        lastSavedRef.current = spec;
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
  }, [card.id]);

  useEffect(() => {
    if (!registerSpecFlush) return;
    registerSpecFlush(async () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const next = markdownRef.current;
      if (stepDone || next === lastSavedRef.current) return;
      await api.putSpec(card.id, next);
      lastSavedRef.current = next;
    });
    return () => registerSpecFlush(null);
  }, [card.id, registerSpecFlush, stepDone]);

  function cancelPendingSave() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

  function handleChange(next: string) {
    setMarkdown(next);
    if (stepDone || streaming) return;
    if (next === lastSavedRef.current) return;
    cancelPendingSave();
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

  function applyRevision(next: string) {
    cancelPendingSave();
    if (next === markdownRef.current) {
      lastSavedRef.current = next;
      return;
    }
    setMarkdown(next);
    lastSavedRef.current = next;
    markdownRef.current = next;
    setSaveError(null);
    // Same render as `markdown` — MDXEditor remounts with the harvested body.
    setEditorContentKey((k) => k + 1);
  }

  async function refreshSpecFromArtifact() {
    try {
      const latest = await api
        .getLatestArtifact(card.id, { stepKey: "spec", round: 0, kind: "spec" })
        .then((a) => a.content)
        .catch((err: unknown) => {
          if (err instanceof Error && err.message === "not found") return null;
          throw err;
        });
      if (latest == null) return;
      if (latest === markdownRef.current) return;
      applyRevision(latest);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
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

  const editorLocked = stepDone || streaming;

  function setAssistStreaming(next: boolean) {
    if (next) cancelPendingSave();
    // Turn finished while collapsed → mark unread until the panel is opened.
    if (!next && wasStreamingRef.current && !assistOpenRef.current) {
      setAssistUnread(true);
    }
    const turnEnded = wasStreamingRef.current && !next;
    wasStreamingRef.current = next;
    setStreaming(next);
    // Belt-and-suspenders: reload Spec artifact when a turn ends (covers a
    // missed spec-revised frame; no-op when content already matches).
    if (turnEnded) void refreshSpecFromArtifact();
  }

  function openAssist() {
    setAssistOpen(true);
    setAssistUnread(false);
  }

  function closeAssist() {
    setAssistOpen(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          assistOpen && "md:flex-row md:gap-4",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SpecEditor
            ref={editorRef}
            markdown={markdown}
            contentKey={editorContentKey}
            readOnly={editorLocked}
            onChange={handleChange}
          />
        </div>
        {!stepDone ? (
          <TooltipProvider>
            {!assistOpen ? (
              <AssistLauncherFab
                panelId="spec-assist-panel"
                labels={SPEC_ASSIST_LABELS}
                streaming={streaming}
                unread={assistUnread}
                onExpand={openAssist}
              />
            ) : null}
            <DefineAssistSidePanel
              panelId="spec-assist-panel"
              labels={SPEC_ASSIST_LABELS}
              open={assistOpen}
              streaming={streaming}
              onClose={closeAssist}
            >
              <DefineAssistChat
                cardId={card.id}
                stepKey="spec"
                labels={SPEC_ASSIST_LABELS}
                getLiveDraftBody={() => markdownRef.current}
                onSpecRevised={applyRevision}
                onStreamingChange={setAssistStreaming}
                composerLocked={streaming}
              />
            </DefineAssistSidePanel>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}
