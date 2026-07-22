import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { IconPaperclip, IconSend } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import type { StepPanelProps } from "./step-panel-types";

/** Grill tab — assistant-ui thread + composer over AcpBridge WebSocket. */
export function StepGrill({ card }: StepPanelProps) {
  const chat = useAcpChat({ cardId: card.id, stepKey: "grill", round: 0 });

  if (chat.status === "connecting") {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-muted-foreground">Starting grill session…</p>
      </div>
    );
  }

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-destructive">Could not start grill session</p>
        <p className="max-w-md text-sm text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  return (
    <AcpChatProvider transport={chat.transport} messages={chat.messages}>
      <GrillThread />
    </AcpChatProvider>
  );
}

function GrillThread() {
  return (
    <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <p className="text-muted-foreground">Waiting for the agent…</p>
        </AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <div className="flex items-end gap-2 border-t p-3">
        <Button variant="ghost" size="icon-sm" disabled title="Attach files">
          <IconPaperclip />
        </Button>
        <ComposerPrimitive.Root className="flex flex-1 items-end gap-2">
          <ComposerPrimitive.Input
            rows={1}
            placeholder="Message…"
            className="min-h-9 flex-1 resize-none"
          />
          <ComposerPrimitive.Send asChild>
            <Button size="icon-sm" title="Send">
              <IconSend />
            </Button>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
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
      <div className="max-w-[85%]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
