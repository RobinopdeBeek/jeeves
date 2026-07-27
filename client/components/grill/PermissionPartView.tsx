import { makeAssistantDataUI } from "@assistant-ui/react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { PermissionRequestData } from "@/hooks/acp-chat-transport";
import { useGrillTransport } from "./transport-context";

/** Inline approve/deny UI for AI SDK `data-permission` parts. */
export function PermissionPartView({
  data,
  interactive = true,
}: {
  data: PermissionRequestData;
  /** When false (read-only transcript), never enable approve/deny. */
  interactive?: boolean;
}) {
  const transport = useGrillTransport();
  const pending = interactive && data.status === "pending" && !!transport;

  const selectedLabel = useMemo(() => {
    if (!data.selectedOptionId) return null;
    return (
      data.options.find((o) => o.optionId === data.selectedOptionId)?.name ??
      data.selectedOptionId
    );
  }, [data.options, data.selectedOptionId]);

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">{data.title ?? "Permission required"}</p>
      {data.status === "resolved" ? (
        <p className="text-muted-foreground">
          {selectedLabel ? `Selected: ${selectedLabel}` : "Resolved"}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={option.kind.startsWith("allow") ? "default" : "outline"}
              disabled={!pending}
              onClick={() =>
                transport?.respondToPermission(data.requestId, option.optionId)
              }
            >
              {option.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Registers a renderer for AI SDK `data-permission` parts. */
export const PermissionDataUI = makeAssistantDataUI<PermissionRequestData>({
  name: "permission",
  render: ({ data }) => <PermissionPartView data={data} />,
});
