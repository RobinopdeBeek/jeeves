import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ArtifactContent, type Run } from "@/lib/api";
import { useJeevesEvents } from "@/lib/events";
import {
  initialLogOpen,
  logOpenAfterFinish,
  stepExecutionMode,
  usesFrozenArtifacts,
} from "@/lib/step-execution-view";
import { Button } from "@/components/ui/button";
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

/**
 * Plan / Implement / AI Review run-log panel: queued message → live SSE
 * stream while ai-working → stacked plan + frozen log when finished.
 */
export function StepExecution({ card, stepKey, onCardChange }: StepPanelProps) {
  const step = card.steps.find((s) => s.key === stepKey);
  const mode = stepExecutionMode(step?.status);
  const round = 0;

  const [lines, setLines] = useState<string[]>([]);
  const [latestRun, setLatestRun] = useState<Run | null>(null);
  const [planArtifact, setPlanArtifact] = useState<ArtifactContent | null>(null);
  const [logOpen, setLogOpen] = useState(() => initialLogOpen(step?.status));
  const [retrying, setRetrying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const wasLiveRef = useRef(step?.status === "ai-working");

  async function loadArtifacts() {
    const [plan, runlog] = await Promise.all([
      stepKey === "plan"
        ? fetchArtifact(card.id, stepKey, round, "plan")
        : Promise.resolve(null),
      fetchArtifact(card.id, stepKey, round, "runlog"),
    ]);
    setPlanArtifact(plan);
    if (runlog?.content) {
      setLines(runlog.content.split(/\r?\n/).filter((line, i, arr) => line || i < arr.length - 1));
    }
  }

  // Latest run + persisted log tail — initial load and reconnect catch-up.
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
      setLines(withLog.log ? withLog.log.split(/\r?\n/) : []);
    } else {
      setLines([]);
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
      if (event.cardId !== card.id) return;
      if (event.type === "run.log") {
        if (!acceptsRunEvent(event.runId)) return;
        setLines((prev) => [...prev, event.line]);
      }
      if (event.type === "run.finished") {
        if (!acceptsRunEvent(event.runId)) return;
        loadLatest().catch(console.error);
      }
    },
    // On SSE reconnect, re-fetch the log tail to cover the gap.
    () => loadLatest().catch(console.error),
  );

  useEffect(() => {
    if (mode === "live" || logOpen) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [lines, mode, logOpen]);

  async function retry() {
    setRetrying(true);
    try {
      const updated = await api.retryStep(card.id, stepKey);
      onCardChange(updated);
      activeRunIdRef.current = null;
      wasLiveRef.current = false;
      setLines([]);
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

  function renderLogLines() {
    return lines.map((line, i) => (
      <div key={i} className="whitespace-pre-wrap break-all">
        {line}
      </div>
    ));
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      {usesFrozenArtifacts(mode) && stepKey === "plan" && planArtifact && (
        <div className="overflow-y-auto rounded-lg border p-4 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{planArtifact.content}</ReactMarkdown>
        </div>
      )}

      {usesFrozenArtifacts(mode) ? (
        <details
          className="flex flex-1 flex-col overflow-hidden rounded-lg border"
          open={logOpen}
          onToggle={(e) => setLogOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer border-b px-4 py-2 text-sm font-medium">
            Run log
          </summary>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 font-mono text-sm">
            {renderLogLines()}
            {failed && latestRun?.error && (
              <div className="text-destructive">[failed] {latestRun.error}</div>
            )}
            {lines.length === 0 && !failed && (
              <div className="text-muted-foreground">[empty] no log output recorded</div>
            )}
          </div>
        </details>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 font-mono text-sm">
            {mode === "queued" && (
              <div className="text-muted-foreground">
                [queued] {step?.label} step waiting in queue…
              </div>
            )}
            {renderLogLines()}
            {mode === "live" && lines.length === 0 && (
              <div className="text-muted-foreground">[starting] agent is warming up…</div>
            )}
            {failed && latestRun?.error && (
              <div className="text-destructive">[failed] {latestRun.error}</div>
            )}
          </div>
        </div>
      )}

      {failed && (
        <div className="flex justify-end">
          <Button variant="outline" disabled={retrying} onClick={retry}>
            <IconRefresh data-icon="inline-start" />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
