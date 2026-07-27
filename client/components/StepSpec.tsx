import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { ReadOnlyTranscript } from "@/components/grill/ReadOnlyTranscript";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { api } from "@/lib/api";
import type { StepPanelProps } from "./step-panel-types";
import { SpecEditor } from "./spec/SpecEditor";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Spec authoring surface: MDXEditor + Spec assist side-chat (Grill chat stack).
 * Grill session is Spec's upstream input ([ADR 0012](../../docs/adr/0012-grill-session-qa-handoff.md)).
 */
export function StepSpec({ card, onSpecBodyChange }: StepPanelProps) {
  const specStep = card.steps.find((s) => s.key === "spec");
  const stepDone = specStep?.status === "done";
  const [markdown, setMarkdown] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [revisionEpoch, setRevisionEpoch] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);

    void (async () => {
      try {
        const spec = await api
          .getLatestArtifact(card.id, { stepKey: "spec", round: 0, kind: "spec" })
          .then((a) => a.content)
          .catch(() => "");
        if (cancelled) return;
        setMarkdown(spec);
        lastSavedRef.current = spec;
        onSpecBodyChange?.(spec);
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

  function cancelPendingSave() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

  function handleChange(next: string) {
    setMarkdown(next);
    onSpecBodyChange?.(next);
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
    setMarkdown(next);
    lastSavedRef.current = next;
    onSpecBodyChange?.(next);
    setSaveError(null);
    setRevisionEpoch((n) => n + 1);
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
            key={`${card.id}-${revisionEpoch}`}
            markdown={markdown}
            readOnly={editorLocked}
            onChange={handleChange}
          />
        </div>
        {!stepDone ? (
          <aside className="flex max-h-80 min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-md border md:max-h-none md:w-96">
            <div className="border-b px-3 py-2 text-sm font-medium">Spec assist</div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <SpecAssistChat
                cardId={card.id}
                getCurrentSpecMarkdown={() => markdownRef.current}
                onSpecRevised={applyRevision}
                onStreamingChange={(next) => {
                  if (next) cancelPendingSave();
                  setStreaming(next);
                }}
                composerLocked={streaming}
              />
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function SpecAssistChat({
  cardId,
  getCurrentSpecMarkdown,
  onSpecRevised,
  onStreamingChange,
  composerLocked,
}: {
  cardId: string;
  getCurrentSpecMarkdown: () => string;
  onSpecRevised: (markdown: string) => void;
  onStreamingChange: (streaming: boolean) => void;
  composerLocked: boolean;
}) {
  const chat = useAcpChat({
    cardId,
    stepKey: "spec",
    round: 0,
    getCurrentSpecMarkdown,
    onSpecRevised,
    onStreamingChange,
  });

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
        <p className="text-sm text-destructive">Could not start Spec assist</p>
        <p className="text-xs text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <ThreadShell />;
  }

  if (chat.status === "displaced") {
    return (
      <DisplacedSpecAssist
        cardId={cardId}
        reason={chat.reason}
        fallbackMessages={chat.messages}
      />
    );
  }

  return (
    <AcpChatProvider transport={chat.transport} messages={chat.messages}>
      <GrillTransportContext.Provider value={chat.transport}>
        <PermissionDataUI />
        <Thread
          sessionOpen={chat.sessionOpen && !composerLocked}
          welcomeTitle="Ask about the Spec or request a revision"
          placeholder="Ask or request a change…"
          openingPlaceholder={
            composerLocked ? "Spec assist is working…" : "Spec assist starting…"
          }
        />
      </GrillTransportContext.Provider>
    </AcpChatProvider>
  );
}

function DisplacedSpecAssist({
  cardId,
  reason,
  fallbackMessages,
}: {
  cardId: string;
  reason: string;
  fallbackMessages: UIMessage[];
}) {
  const banner =
    reason === "session continued elsewhere"
      ? "Session continued elsewhere"
      : reason;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="border-b bg-muted px-3 py-2 text-center text-xs text-muted-foreground"
        role="status"
      >
        {banner}
      </div>
      <ReadOnlyTranscript
        cardId={cardId}
        stepKey="spec"
        fallbackMessages={fallbackMessages}
      />
    </div>
  );
}
