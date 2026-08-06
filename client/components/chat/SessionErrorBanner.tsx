import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * The agent process failed to start (spawn, auth, handshake). The composer
 * stays live underneath: sending again is the retry, so whatever the user typed
 * is never thrown away by an error screen.
 */
export function SessionErrorBanner({ error }: { error: string }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <IconAlertTriangle className="size-3.5 text-destructive" />
      Agent could not start: {error}. Sending again retries.
    </div>
  );
}
