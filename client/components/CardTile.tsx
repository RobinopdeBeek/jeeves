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

export function CardTile({ card }: { card: Card }) {
  const navigate = useNavigate();
  const pipeline = showsPipelineChrome(card);
  const attention = pipeline && needsUserAttention(card);
  const segments =
    pipeline && card.column
      ? columnWorkSteps(card.steps, card.column)
      : [];
  const current = pipeline ? activeStep(card.steps) : undefined;

  return (
    <button
      type="button"
      onClick={() => navigate(`/cards/${card.id}`)}
      className={cardTileVariants({ attention })}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium">
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
          {current && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StepStatusIcon status={current.status} />
              <span>{current.label}</span>
            </div>
          )}
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
