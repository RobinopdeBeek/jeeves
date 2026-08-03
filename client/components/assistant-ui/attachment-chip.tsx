import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Compact chip for a composer / transcript attachment (layout + shared chrome). */
export function AttachmentChip({
  name,
  previewUrl,
  className,
  trailing,
}: {
  name: string;
  /** Optional image thumbnail (data URL or hosted). */
  previewUrl?: string;
  className?: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "inline-flex max-w-xs items-center gap-2 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs text-foreground",
        className,
      )}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt=""
          className="size-8 shrink-0 rounded object-cover"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      {trailing}
    </div>
  );
}
