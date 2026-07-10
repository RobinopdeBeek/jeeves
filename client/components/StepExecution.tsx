import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { api, type Run } from "@/lib/api";
import { useJeevesEvents } from "@/lib/events";
import { Button } from "@/components/ui/button";
import type { StepPanelProps } from "./step-panel-types";

/**
 * Plan / Implement / AI Review run-log panel: queued message → live SSE
 * stream while ai-working → frozen log (+ Retry on failure) when finished.
 */
export function StepExecution({ card, stepKey, onCardChange }: StepPanelProps) {
  const step = card.steps.find((s) => s.key === stepKey);
  const [lines, setLines] = useState<string[]>([]);
  const [latestRun, setLatestRun] = useState<Run | null>(null);
  const [retrying, setRetrying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRunIdRef = useRef<string | null>(null);

  // Latest run + persisted log tail — initial load and reconnect catch-up.
  async function loadLatest() {
    const runs = await api.listRuns(card.id);
    const run = runs.find((r) => r.stepKey === stepKey);
    setLatestRun(run ?? null);
    activeRunIdRef.current =
      run?.status === "running" ? run.id : (run?.id ?? null);
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
  }, [card.id, stepKey]);

  const prevStepStatus = useRef(step?.status);
  useEffect(() => {
    if (prevStepStatus.current !== step?.status && step?.status === "ai-working") {
      activeRunIdRef.current = null;
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  async function retry() {
    setRetrying(true);
    try {
      const updated = await api.retryStep(card.id, stepKey);
      onCardChange(updated);
      activeRunIdRef.current = null;
      setLines([]);
      setLatestRun(null);
    } catch (err) {
      console.error(err);
    } finally {
      setRetrying(false);
    }
  }

  const failed = step?.status === "needs-user" && latestRun?.status === "failed";

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 font-mono text-sm">
          {step?.status === "queued" && (
            <div className="text-muted-foreground">
              [queued] {step.label} step waiting in queue…
            </div>
          )}
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
          {step?.status === "ai-working" && lines.length === 0 && (
            <div className="text-muted-foreground">[starting] agent is warming up…</div>
          )}
          {failed && latestRun?.error && (
            <div className="text-destructive">[failed] {latestRun.error}</div>
          )}
        </div>
      </div>

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
