import { IconPaperclip } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { StepPanelProps } from "./step-panel-types";

/** Grill tab layout — message area + composer chrome; live AI arrives in slice 5. */
export function StepGrill(_props: StepPanelProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-lg border">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">
          Grill chat will appear here. Start a session in a later slice.
        </p>
      </div>
      <div className="flex items-end gap-2 border-t p-3">
        <Button variant="ghost" size="icon-sm" disabled title="Attach files">
          <IconPaperclip />
        </Button>
        <Textarea
          rows={1}
          disabled
          placeholder="Message…"
          className="min-h-9 resize-none"
        />
      </div>
    </div>
  );
}
