import {
  IconLayoutSidebarRightCollapse,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, useRef, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { attachmentAcceptFor } from "@shared/prompt-capabilities";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { ReadOnlyTranscript } from "@/components/grill/ReadOnlyTranscript";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TasksDraftTip } from "@/lib/api";
import { cn } from "@/lib/utils";

const MD_QUERY = "(min-width: 768px)";
/** Desktop assist column width — matches Tailwind `w-96`. */
const ASSIST_PANEL_WIDTH_PX = 384;

function useIsMd() {
  const [isMd, setIsMd] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(MD_QUERY).matches : true,
  );
  useEffect(() => {
    const mq = window.matchMedia(MD_QUERY);
    const onChange = () => setIsMd(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMd;
}

/** Shared Define assist chrome labels (Spec / Tasks). */
export type DefineAssistLabels = {
  working: string;
  unread: string;
  show: string;
  hide: string;
  startError: string;
  openingPlaceholder: string;
  workingPlaceholder: string;
};

export function AssistLauncherFab({
  panelId,
  labels,
  streaming,
  unread,
  onExpand,
}: {
  panelId: string;
  labels: DefineAssistLabels;
  streaming: boolean;
  unread: boolean;
  onExpand: () => void;
}) {
  const statusLabel = streaming
    ? labels.working
    : unread
      ? labels.unread
      : labels.show;
  const reduceMotion = useReducedMotion();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
          }
          className="absolute right-3 bottom-3 z-30"
        >
          <Button
            type="button"
            variant="launcher"
            size="icon-launcher"
            onClick={onExpand}
            aria-expanded={false}
            aria-controls={panelId}
            aria-label={statusLabel}
          >
            <Logo className="size-20" />
            {streaming ? (
              <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full bg-background shadow-sm">
                <IconLoader2
                  className="size-4 animate-spin text-pipeline-ai"
                  aria-hidden
                />
              </span>
            ) : null}
            {!streaming && unread ? (
              <span
                className="pointer-events-none absolute top-1 right-1 size-3 rounded-full bg-pipeline-user ring-2 ring-white"
                aria-hidden
              />
            ) : null}
          </Button>
        </motion.div>
      </TooltipTrigger>
      <TooltipContent side="left">{statusLabel}</TooltipContent>
    </Tooltip>
  );
}

/** Desktop (md+) starts with assist open; mobile starts closed (launcher FAB). */
export function initialAssistOpen(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(min-width: 768px)").matches;
}

export function DefineAssistSidePanel({
  panelId,
  labels,
  open,
  streaming,
  onClose,
  children,
}: {
  panelId: string;
  labels: DefineAssistLabels;
  open: boolean;
  streaming: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const isMd = useIsMd();
  // Keep chat mounted across close so the ACP session is not torn down.
  // Hide with display:none after the exit tween (via transitionEnd).
  const panelTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };
  const panelExitTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.15, ease: [0.4, 0, 1, 1] as const };

  // Desktop: fade + collapse width in-flow (avoids layout jump).
  // Mobile: fade + slight rise (absolute overlay).
  const openVariant = isMd
    ? {
        opacity: 1,
        width: ASSIST_PANEL_WIDTH_PX,
        display: "flex" as const,
        transition: panelTransition,
      }
    : {
        opacity: 1,
        y: 0,
        display: "flex" as const,
        transition: panelTransition,
      };
  const closedVariant = isMd
    ? {
        opacity: 0,
        width: 0,
        transition: panelExitTransition,
        transitionEnd: { display: "none" as const },
      }
    : {
        opacity: 0,
        y: reduceMotion ? 0 : 10,
        transition: panelExitTransition,
        transitionEnd: { display: "none" as const },
      };

  return (
    <motion.aside
      initial={false}
      animate={open ? "open" : "closed"}
      variants={{ open: openVariant, closed: closedVariant }}
      className={cn(
        "flex flex-col overflow-hidden rounded-md border bg-background",
        "absolute inset-x-3 top-1/4 bottom-3 z-50 shadow-lg md:static md:inset-auto md:z-auto md:w-96 md:shrink-0 md:shadow-none",
        !open && "pointer-events-none",
      )}
    >
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5 md:gap-1 md:px-2 md:py-1">
        <span className="min-w-0 flex-1 truncate px-1 text-[1.3125rem] font-medium md:text-sm">
          Jeeves
        </span>
        {streaming ? (
          <IconLoader2
            className="size-[1.3125rem] shrink-0 animate-spin text-pipeline-ai md:size-3.5"
            aria-label={labels.working}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:size-6 md:[&_svg:not([class*='size-'])]:size-3"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={labels.hide}
              onClick={onClose}
            >
              <IconX className="md:hidden" />
              <IconLayoutSidebarRightCollapse className="hidden md:block" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{labels.hide}</TooltipContent>
        </Tooltip>
      </div>
      <div
        id={panelId}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {children}
      </div>
    </motion.aside>
  );
}

export function DefineAssistChat({
  cardId,
  stepKey,
  labels,
  getLiveDraftBody,
  onSpecRevised,
  onTasksRevised,
  onStreamingChange,
  onDisplaced,
  composerLocked,
}: {
  cardId: string;
  stepKey: "spec" | "tasks";
  labels: DefineAssistLabels;
  getLiveDraftBody: () => string;
  onSpecRevised?: (markdown: string) => void;
  onTasksRevised?: (draft: TasksDraftTip) => void;
  onStreamingChange: (streaming: boolean) => void;
  onDisplaced?: () => void;
  composerLocked: boolean;
}) {
  const chat = useAcpChat({
    cardId,
    stepKey,
    round: 0,
    getLiveDraftBody,
    onSpecRevised,
    onTasksRevised,
    onStreamingChange,
  });

  const displacedNotified = useRef(false);
  useEffect(() => {
    if (chat.status === "displaced" && onDisplaced && !displacedNotified.current) {
      displacedNotified.current = true;
      onDisplaced();
    }
  }, [chat.status, onDisplaced]);

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
        <p className="text-sm text-destructive">{labels.startError}</p>
        <p className="text-xs text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <ThreadShell />;
  }

  if (chat.status === "displaced") {
    return (
      <DisplacedDefineAssist
        cardId={cardId}
        stepKey={stepKey}
        reason={chat.reason}
        fallbackMessages={chat.messages}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.connection === "reconnecting" ? <ReconnectingBanner /> : null}
      <AcpChatProvider
        key={`${chat.epoch}:${attachmentAcceptFor(chat.promptCapabilities)}`}
        transport={chat.transport}
        messages={chat.messages}
        promptCapabilities={chat.promptCapabilities}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <Thread
            // Keep sessionOpen true while streaming — flipping it false swaps the
            // composer for a "Starting session" spinner and feels like the panel hid.
            sessionOpen={chat.sessionOpen}
            attachmentsEnabled={
              attachmentAcceptFor(chat.promptCapabilities).length > 0
            }
            placeholder={
              composerLocked
                ? labels.workingPlaceholder
                : "Ask or request a change…"
            }
            openingPlaceholder={labels.openingPlaceholder}
          />
        </GrillTransportContext.Provider>
      </AcpChatProvider>
    </div>
  );
}

function DisplacedDefineAssist({
  cardId,
  stepKey,
  reason,
  fallbackMessages,
}: {
  cardId: string;
  stepKey: "spec" | "tasks";
  reason: string;
  fallbackMessages: UIMessage[];
}) {
  const banner =
    reason === "session continued elsewhere"
      ? "Session continued elsewhere"
      : reason;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="border-b bg-muted px-3 py-2 text-center text-xs text-muted-foreground"
        role="status"
      >
        {banner}
      </div>
      <ReadOnlyTranscript
        cardId={cardId}
        stepKey={stepKey}
        fallbackMessages={fallbackMessages}
      />
    </div>
  );
}

export const SPEC_ASSIST_LABELS: DefineAssistLabels = {
  working: "Spec assist is working",
  unread: "New Spec assist reply",
  show: "Show Spec assist",
  hide: "Hide Spec assist",
  startError: "Could not start Spec assist",
  openingPlaceholder: "Spec assist starting…",
  workingPlaceholder: "Spec assist is working…",
};

export const TASKS_ASSIST_LABELS: DefineAssistLabels = {
  working: "Tasks assist is working",
  unread: "New Tasks assist reply",
  show: "Show Tasks assist",
  hide: "Hide Tasks assist",
  startError: "Could not start Tasks assist",
  openingPlaceholder: "Tasks assist starting…",
  workingPlaceholder: "Tasks assist is working…",
};
