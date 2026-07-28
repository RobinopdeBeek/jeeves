import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconLoader2,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { ReadOnlyTranscript } from "@/components/grill/ReadOnlyTranscript";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
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
export function StepSpec({ card, registerSpecFlush }: StepPanelProps) {
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
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
            <aside
              className={cn(
                "flex shrink-0 flex-col overflow-hidden rounded-md border",
                assistOpen
                  ? "max-h-80 min-h-0 w-full md:max-h-none md:w-96"
                  : "w-full md:w-10",
              )}
            >
              {assistOpen ? (
                <div className="flex items-center gap-1 border-b px-2 py-1">
                  <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
                    Spec assist
                  </span>
                  {streaming ? (
                    <IconLoader2
                      className="size-3.5 shrink-0 animate-spin text-pipeline-ai"
                      aria-label="Spec assist is working"
                    />
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-expanded={true}
                        aria-controls="spec-assist-panel"
                        aria-label="Hide Spec assist"
                        onClick={closeAssist}
                      >
                        <IconLayoutSidebarRightCollapse />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Hide Spec assist</TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <CollapsedAssistRail
                  streaming={streaming}
                  unread={assistUnread}
                  onExpand={openAssist}
                />
              )}
              {/* Keep chat mounted while collapsed so the ACP session stays alive. */}
              <div
                id="spec-assist-panel"
                className={cn(
                  "flex min-h-0 flex-1 flex-col overflow-hidden",
                  !assistOpen && "hidden",
                )}
              >
                <SpecAssistChat
                  cardId={card.id}
                  getCurrentSpecMarkdown={() => markdownRef.current}
                  onSpecRevised={applyRevision}
                  onStreamingChange={setAssistStreaming}
                  composerLocked={streaming}
                />
              </div>
            </aside>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}

function CollapsedAssistRail({
  streaming,
  unread,
  onExpand,
}: {
  streaming: boolean;
  unread: boolean;
  onExpand: () => void;
}) {
  const statusLabel = streaming
    ? "Spec assist is working"
    : unread
      ? "New Spec assist reply"
      : "Show Spec assist";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={false}
          aria-controls="spec-assist-panel"
          aria-label={statusLabel}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent",
            "md:flex-col md:items-center md:gap-3 md:px-0 md:py-3",
          )}
        >
          <IconLayoutSidebarRightExpand className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground md:hidden">
            Spec assist
          </span>
          {streaming ? (
            <IconLoader2
              className="size-3.5 shrink-0 animate-spin text-pipeline-ai"
              aria-hidden
            />
          ) : unread ? (
            <span
              className="size-2 shrink-0 rounded-full bg-pipeline-user"
              aria-hidden
            />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{statusLabel}</TooltipContent>
    </Tooltip>
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
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.connection === "reconnecting" ? <ReconnectingBanner /> : null}
      {/* epoch remounts the runtime after a reconnect so the server transcript wins. */}
      <AcpChatProvider
        key={chat.epoch}
        transport={chat.transport}
        messages={chat.messages}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <Thread
            sessionOpen={chat.sessionOpen && !composerLocked}
            placeholder="Ask or request a change…"
            openingPlaceholder={
              composerLocked ? "Spec assist is working…" : "Spec assist starting…"
            }
          />
        </GrillTransportContext.Provider>
      </AcpChatProvider>
    </div>
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
