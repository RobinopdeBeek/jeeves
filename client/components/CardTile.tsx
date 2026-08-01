import { IconFlag } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import type { Card } from "@/lib/api";
import {
  activeStep,
  columnWorkSteps,
  needsUserAttention,
  showsPipelineChrome,
} from "@/lib/card-steps";
import {
  StepStatusIcon,
  TileSegmentBar,
  cardTileVariants,
} from "@/components/ui/pipeline-status";
import { cn } from "@/lib/utils";

/** Board tile and Feature Tasks child list share this shape. */
export type CardTileModel = Pick<
  Card,
  | "id"
  | "title"
  | "description"
  | "kind"
  | "column"
  | "steps"
  | "creatingSpec"
  | "creatingTasks"
  | "implementProgress"
>;

export function CardTile({ card }: { card: CardTileModel }) {
  const navigate = useNavigate();
  const pipeline = showsPipelineChrome(card);
  const attention =
    pipeline &&
    needsUserAttention({
      column: card.column,
      steps: card.steps,
    });
  const segments =
    pipeline && card.column
      ? columnWorkSteps(card.steps, card.column)
      : [];
  const current = pipeline ? activeStep(card.steps) : undefined;
  const tasksAwaiting = current?.key === "tasks" && current.status === "awaiting";
  const progress = card.implementProgress;

  return (
    <button
      type="button"
      onClick={() => navigate(`/cards/${card.id}`)}
      className={cn(cardTileVariants({ attention }), "w-full")}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 line-clamp-2 text-sm font-medium">
          {card.title || <em className="text-muted-foreground">Untitled</em>}
        </div>
        {card.kind === "feature" && (
          <IconFlag
            className="size-4 shrink-0 text-foreground"
            aria-label="Feature"
          />
        )}
      </div>

      {pipeline ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <TileSegmentBar steps={segments} />
          {card.creatingSpec ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StepStatusIcon status="ai-working" />
              <span>Creating Spec…</span>
            </div>
          ) : card.creatingTasks ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StepStatusIcon status="ai-working" />
              <span>Creating Tasks…</span>
            </div>
          ) : tasksAwaiting && progress ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StepStatusIcon status="awaiting" />
              <span>
                Implementing Task {progress.current} of {progress.total}
              </span>
            </div>
          ) : current ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StepStatusIcon status={current.status} />
              <span>{current.label}</span>
            </div>
          ) : null}
        </div>
      ) : card.description ? (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {card.description}
        </div>
      ) : (
        <div className="mt-1 text-xs italic text-muted-foreground">No description</div>
      )}
    </button>
  );
}
