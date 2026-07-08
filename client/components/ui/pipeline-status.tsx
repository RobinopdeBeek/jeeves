import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import type { StepStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

export const cardTileVariants = cva(
  "rounded-lg border bg-card p-3 text-left shadow-xs transition-colors hover:bg-accent",
  {
    variants: {
      attention: {
        true: "border-pipeline-user ring-1 ring-pipeline-user",
        false: "",
      },
    },
    defaultVariants: {
      attention: false,
    },
  },
);

const stepStatusIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center",
  {
    variants: {
      status: {
        done: "size-4 rounded-full bg-pipeline-done text-white",
        "ai-working": "size-4 text-pipeline-ai",
        "needs-user":
          "size-3.5 rounded-full border-2 border-pipeline-user bg-transparent",
        queued:
          "size-3.5 rounded-full border border-dashed border-pipeline-ai/60 bg-transparent",
        pending:
          "size-3.5 rounded-full border border-border bg-transparent",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  },
);

export function StepStatusIcon({
  status,
  className,
}: {
  status: StepStatus;
  className?: string;
}) {
  if (status === "done") {
    return (
      <span className={cn(stepStatusIconVariants({ status: "done" }), className)}>
        <IconCheck className="size-2.5" stroke={3} />
      </span>
    );
  }
  if (status === "ai-working") {
    return (
      <span className={cn(stepStatusIconVariants({ status: "ai-working" }), className)}>
        <IconLoader2 className="size-3.5 animate-spin" />
      </span>
    );
  }
  return (
    <span
      className={cn(stepStatusIconVariants({ status }), className)}
      aria-hidden
    />
  );
}

const segmentVariants = cva("h-1 flex-1 rounded-sm", {
  variants: {
    status: {
      done: "bg-pipeline-done",
      "ai-working": "bg-pipeline-ai",
      "needs-user": "bg-pipeline-user",
      queued: "bg-secondary ring-1 ring-inset ring-pipeline-ai/55",
      pending: "bg-secondary",
    },
  },
  defaultVariants: {
    status: "pending",
  },
});

export function TileSegmentBar({
  steps,
  className,
}: {
  steps: Array<{ key: string; status: StepStatus; label: string }>;
  className?: string;
}) {
  if (steps.length === 0) return null;

  return (
    <div className={cn("flex gap-0.5", className)} aria-hidden>
      {steps.map((step) => (
        <div
          key={step.key}
          className={segmentVariants({ status: step.status })}
          title={step.label}
        />
      ))}
    </div>
  );
}

export type StepStatusIconVariant = VariantProps<typeof stepStatusIconVariants>;
