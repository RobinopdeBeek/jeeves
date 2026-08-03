import { useEffect } from "react";
import type { UIMessage } from "ai";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { attachmentAcceptFor } from "@shared/prompt-capabilities";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { GrillSessionView } from "@/components/grill/GrillSessionView";
import { ReadOnlyTranscript } from "@/components/grill/ReadOnlyTranscript";
import { GrillTransportContext } from "@/components/grill/transport-context";
import type { StepPanelProps } from "./step-panel-types";

/** Grill tab — reusable assistant-ui Thread over AcpBridge WebSocket. */
export function StepGrill({
  card,
  synthesizingSpec,
  onGrillStartingChange,
}: StepPanelProps) {
  const grill = card.steps.find((s) => s.key === "grill");
  if (grill?.status === "done") {
    return <CompletedGrill cardId={card.id} />;
  }

  if (synthesizingSpec) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-muted-foreground">
          Creating Spec from our Grill session…
        </p>
      </div>
    );
  }

  return (
    <LiveGrill cardId={card.id} onGrillStartingChange={onGrillStartingChange} />
  );
}

function LiveGrill({
  cardId,
  onGrillStartingChange,
}: {
  cardId: string;
  onGrillStartingChange?: (starting: boolean) => void;
}) {
  const chat = useAcpChat({ cardId, stepKey: "grill", round: 0 });

  const starting =
    chat.status === "connecting" ||
    (chat.status === "ready" && !chat.sessionOpen);

  useEffect(() => {
    onGrillStartingChange?.(starting);
    return () => onGrillStartingChange?.(false);
  }, [starting, onGrillStartingChange]);

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-destructive">Could not start grill session</p>
        <p className="max-w-md text-sm text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <ThreadShell />;
  }

  if (chat.status === "displaced") {
    return (
      <DisplacedGrill
        cardId={cardId}
        reason={chat.reason}
        fallbackMessages={chat.messages}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.connection === "reconnecting" ? <ReconnectingBanner /> : null}
      {/* epoch remounts the runtime after a reconnect so the server transcript wins. */}
      <AcpChatProvider
        key={`${chat.epoch}:${attachmentAcceptFor(chat.promptCapabilities)}`}
        transport={chat.transport}
        messages={chat.messages}
        promptCapabilities={chat.promptCapabilities}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <Thread
            sessionOpen={chat.sessionOpen}
            attachmentsEnabled={
              attachmentAcceptFor(chat.promptCapabilities).length > 0
            }
          />
        </GrillTransportContext.Provider>
      </AcpChatProvider>
    </div>
  );
}

/**
 * Completed grill (handed off to Spec): Grill session Q&A markdown, no composer,
 * no live ACP session. Raw transcript stays in storage for resume/debug only.
 */
function CompletedGrill({ cardId }: { cardId: string }) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <GrillSessionView cardId={cardId} />
    </div>
  );
}

/**
 * Displaced writer: banner + latest transcript from the artifact API.
 * Composer is omitted (read-only). Message list is plain replay — no live
 * assistant-ui runtime, matching the frozen/read-only Grill path.
 */
function DisplacedGrill({
  cardId,
  reason,
  fallbackMessages,
}: {
  cardId: string;
  reason: string;
  fallbackMessages: UIMessage[];
}) {
  const banner =
    reason === "session continued elsewhere"
      ? "Session continued elsewhere"
      : reason;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="border-b bg-muted px-4 py-2 text-center text-sm text-muted-foreground"
        role="status"
      >
        {banner}
      </div>
      <ReadOnlyTranscript cardId={cardId} fallbackMessages={fallbackMessages} />
    </div>
  );
}
