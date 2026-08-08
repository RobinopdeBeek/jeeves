import { IconClipboardCheck } from "@tabler/icons-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { StepPanelProps } from "./step-panel-types";

/**
 * Human Review stub — QA gate + eval iframe land in slice 9.
 * Prepare Eval unlocks this tab as needs-user after the stub finishes.
 */
export function StepReview(_props: StepPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconClipboardCheck />
          </EmptyMedia>
          <EmptyTitle>Human Review</EmptyTitle>
          <EmptyDescription>
            Evaluation review surface lands in slice 9.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
