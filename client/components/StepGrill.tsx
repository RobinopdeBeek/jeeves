import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { IconLoader2, IconPaperclip, IconSend } from "@tabler/icons-react";
import type { UIMessage } from "ai";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Button } from "@/components/ui/button";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { ReadOnlyTranscript } from "@/components/grill/ReadOnlyTranscript";
import { GrillTransportContext } from "@/components/grill/transport-context";
import type { StepPanelProps } from "./step-panel-types";

/** Grill tab — assistant-ui thread + composer over AcpBridge WebSocket. */
export function StepGrill({ card }: StepPanelProps) {
  const grill = card.steps.find((s) => s.key === "grill");
  if (grill?.status === "done") {
    return <CompletedGrill cardId={card.id} />;
  }

  return <LiveGrill cardId={card.id} />;
}

function LiveGrill({ cardId }: { cardId: string }) {
  const chat = useAcpChat({ cardId, stepKey: "grill", round: 0 });

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-destructive">Could not start grill session</p>
        <p className="max-w-md text-sm text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <GrillThreadShell />;
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
    <AcpChatProvider transport={chat.transport} messages={chat.messages}>
      <GrillTransportContext.Provider value={chat.transport}>
        <PermissionDataUI />
        <GrillThread sessionOpen={chat.sessionOpen} />
      </GrillTransportContext.Provider>
    </AcpChatProvider>
  );
}

/**
 * Completed grill (handed off to Spec): frozen transcript replay, no composer,
 * no live ACP session.
 */
function CompletedGrill({ cardId }: { cardId: string }) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ReadOnlyTranscript cardId={cardId} fallbackMessages={[]} />
    </div>
  );
}

/** Thread chrome while waiting for transcript `ready` (usually <100ms). */
function GrillThreadShell() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-muted-foreground">Loading conversation…</p>
      </div>
      <div className="flex items-end gap-2 border-t p-3">
        <Button variant="ghost" size="icon-sm" disabled title="Attach files">
          <IconPaperclip />
        </Button>
        <div className="flex flex-1 items-end gap-2">
          <textarea
            rows={1}
            disabled
            placeholder="Loading…"
            className="min-h-9 flex-1 resize-none opacity-50"
          />
          <Button size="icon-sm" disabled title="Starting session…">
            <IconLoader2 className="animate-spin" />
          </Button>
        </div>
      </div>
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

function GrillThread({ sessionOpen }: { sessionOpen: boolean }) {
  return (
    <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <p className="text-muted-foreground">
            {sessionOpen ? "Waiting for the agent…" : "Starting agent session…"}
          </p>
        </AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <GrillComposer sessionOpen={sessionOpen} />
    </ThreadPrimitive.Root>
  );
}

function GrillComposer({ sessionOpen }: { sessionOpen: boolean }) {
  return (
    <div className="flex items-end gap-2 border-t p-3">
      <Button variant="ghost" size="icon-sm" disabled title="Attach files">
        <IconPaperclip />
      </Button>
      <ComposerPrimitive.Root className="flex flex-1 items-end gap-2">
        <ComposerPrimitive.Input
          rows={1}
          placeholder={sessionOpen ? "Message…" : "Agent starting — you can type…"}
          className="min-h-9 flex-1 resize-none"
        />
        {sessionOpen ? (
          <ComposerPrimitive.Send asChild>
            <Button size="icon-sm" title="Send">
              <IconSend />
            </Button>
          </ComposerPrimitive.Send>
        ) : (
          <Button size="icon-sm" disabled title="Starting session…">
            <IconLoader2 className="animate-spin" />
          </Button>
        )}
      </ComposerPrimitive.Root>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}
