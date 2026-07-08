/** Plan tab run-log shell — queued status only; real execution streams in slice 3. */
export function StepPlanShell() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-lg border">
      <div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
        <div className="text-muted-foreground">[queued] Plan step waiting in queue…</div>
      </div>
    </div>
  );
}
