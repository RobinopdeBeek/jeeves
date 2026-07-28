import { IconLoader2 } from "@tabler/icons-react";

/**
 * Shown while the chat WebSocket is being re-established (dev-server restart,
 * sleep, network blip). The transport recovers on its own; the composer is
 * disabled meanwhile so a prompt can never be sent into a dead socket.
 */
export function ReconnectingBanner() {
  return (
    <div
      className="flex shrink-0 items-center justify-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <IconLoader2 className="size-3.5 animate-spin" />
      Reconnecting to the agent…
    </div>
  );
}
