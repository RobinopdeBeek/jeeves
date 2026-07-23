import { IconChevronDown, IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ArtifactContent, type Run } from "@/lib/api";
import { useJeevesEvents } from "@/lib/events";
import { appendLogLine, formatRunLogText } from "@/lib/run-log";
import {
  initialLogOpen,
  logOpenAfterFinish,
  shouldLoadPlanArtifact,
  showPlanArtifact,
  stepExecutionMode,
  usesFrozenArtifacts,
} from "@/lib/step-execution-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { StepPanelProps } from "./step-panel-types";

async function fetchArtifact(
  cardId: string,
  stepKey: string,
  round: number,
  kind: string,
): Promise<ArtifactContent | null> {
  try {
    return await api.getLatestArtifact(cardId, { stepKey, round, kind });
  } catch {
    return null;
  }
}

function toDisplayLog(raw: string): string {
  return formatRunLogText(raw);
}

/**
 * Plan / Implement / AI Review run-log panel: queued message → live SSE
 * stream while ai-working → run log above formatted plan when finished.
 */
export function StepExecution({ card, stepKey, onCardChange }: StepPanelProps) {
  const step = card.steps.find((s) => s.key === stepKey);
  const mode = stepExecutionMode(step?.status);
  const round = 0;

  const [logText, setLogText] = useState("");
  const [latestRun, setLatestRun] = useState<Run | null>(null);
  const [planArtifact, setPlanArtifact] = useState<ArtifactContent | null>(null);
  const [logOpen, setLogOpen] = useState(() => initialLogOpen(step?.status));
  const [retrying, setRetrying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const wasLiveRef = useRef(step?.status === "ai-working");

  async function loadArtifacts() {
    const [plan, runlog] = await Promise.all([
      shouldLoadPlanArtifact(stepKey, step?.status)
        ? fetchArtifact(card.id, stepKey, round, "plan")
        : Promise.resolve(null),
      fetchArtifact(card.id, stepKey, round, "runlog"),
    ]);
    setPlanArtifact(plan);
    if (runlog?.content) {
      setLogText(toDisplayLog(runlog.content));
    }
  }

  async function loadLatest() {
    const runs = await api.listRuns(card.id);
    const run = runs.find((r) => r.stepKey === stepKey);
    setLatestRun(run ?? null);
    activeRunIdRef.current =
      run?.status === "running" ? run.id : (run?.id ?? null);

    if (usesFrozenArtifacts(mode)) {
      await loadArtifacts();
      return;
    }

    if (run) {
      const withLog = await api.getRun(run.id);
      setLogText(withLog.log ? toDisplayLog(withLog.log) : "");
    } else {
      setLogText("");
    }
  }

  function acceptsRunEvent(runId: string): boolean {
    if (activeRunIdRef.current && runId !== activeRunIdRef.current) return false;
    if (!activeRunIdRef.current) activeRunIdRef.current = runId;
    return true;
  }

  useEffect(() => {
    loadLatest().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, stepKey, mode]);

  const prevStepStatus = useRef(step?.status);
  useEffect(() => {
    if (step?.status === "ai-working") wasLiveRef.current = true;
    if (
      prevStepStatus.current === "ai-working" &&
      (step?.status === "done" || step?.status === "needs-user")
    ) {
      setLogOpen(logOpenAfterFinish(wasLiveRef.current));
    }
    if (prevStepStatus.current !== step?.status && step?.status === "ai-working") {
      activeRunIdRef.current = null;
      setPlanArtifact(null);
    }
    prevStepStatus.current = step?.status;
  }, [step?.status]);

  useJeevesEvents(
    (event) => {
      if (event.type !== "run.log" && event.type !== "run.finished") return;
      if (event.cardId !== card.id) return;
      if (event.type === "run.log") {
        if (!acceptsRunEvent(event.runId)) return;
        setLogText((prev) => appendLogLine(prev, event.line));
      } else {
        if (!acceptsRunEvent(event.runId)) return;
        loadLatest().catch(console.error);
      }
    },
    () => loadLatest().catch(console.error),
  );

  useEffect(() => {
    if (mode === "live" || logOpen) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [logText, mode, logOpen]);

  async function retry() {
    setRetrying(true);
    try {
      const updated = await api.retryStep(card.id, stepKey);
      onCardChange(updated);
      activeRunIdRef.current = null;
      wasLiveRef.current = false;
      setLogText("");
      setLatestRun(null);
      setPlanArtifact(null);
      setLogOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setRetrying(false);
    }
  }

  const failed = step?.status === "needs-user" && latestRun?.status === "failed";
  const frozen = usesFrozenArtifacts(mode);
  const showPlan = frozen && showPlanArtifact(stepKey, step?.status, planArtifact);

  function renderLogBody() {
    return (
      <>
        {logText ? (
          <pre className="whitespace-pre-wrap break-words">{logText}</pre>
        ) : null}
        {failed && latestRun?.error && (
          <div className="text-destructive">[failed] {latestRun.error}</div>
        )}
        {!logText && !failed && (
          <div className="text-muted-foreground">[empty] no log output recorded</div>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {frozen ? (
        <>
          <div
            className={cn(
              "flex min-h-0 flex-col overflow-hidden rounded-lg border",
              logOpen ? "flex-1" : "shrink-0",
            )}
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 border-b px-4 py-2 text-left text-sm font-medium"
              onClick={() => setLogOpen((open) => !open)}
            >
              <IconChevronDown
                className={cn("size-4 shrink-0 transition-transform", !logOpen && "-rotate-90")}
              />
              Run log
            </button>
            {logOpen && (
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 font-mono text-sm">
                {renderLogBody()}
              </div>
            )}
          </div>

          {showPlan && planArtifact ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-4 text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{planArtifact.content}</ReactMarkdown>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 font-mono text-sm">
            {mode === "queued" && (
              <div className="text-muted-foreground">
                [queued] {step?.label} step waiting in queue…
              </div>
            )}
            {renderLogBody()}
            {mode === "live" && !logText && (
              <div className="text-muted-foreground">[starting] agent is warming up…</div>
            )}
          </div>
        </div>
      )}

      {failed && (
        <div className="flex shrink-0 justify-end">
          <Button variant="outline" disabled={retrying} onClick={retry}>
            <IconRefresh data-icon="inline-start" />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
