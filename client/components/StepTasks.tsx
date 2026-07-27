import type { StepPanelProps } from "./step-panel-types";

/** Tasks tab stub — draft breakdown arrives in a later slice. */
export function StepTasks(_props: StepPanelProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <p className="text-muted-foreground">Tasks breakdown coming soon.</p>
    </div>
  );
}
