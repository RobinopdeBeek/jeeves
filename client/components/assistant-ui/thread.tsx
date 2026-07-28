"use client";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ComposerTriggerPopover } from "@/components/assistant-ui/composer-trigger-popover";
import { createDirectiveText } from "@/components/assistant-ui/directive-text";
import { Badge } from "@/components/assistant-ui/badge";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type Unstable_SlashCommand,
  unstable_defaultDirectiveFormatter,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  useAuiState,
} from "@assistant-ui/react";
import {
  LexicalComposerInput,
  type DirectiveChipProps,
} from "@assistant-ui/react-lexical";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconFileText,
  IconHelp,
  IconLoader2,
  IconMicrophone,
  IconPaperclip,
  IconSlash,
  IconSquare,
  IconTool,
  IconWorld,
} from "@tabler/icons-react";
import { type FC } from "react";

export type ThreadProps = {
  /** ACP (or other) session ready — send is enabled. */
  sessionOpen?: boolean;
  /**
   * Empty-thread welcome heading. Pass `null` to skip the welcome (e.g. Grill,
   * which auto-starts with an opening turn).
   */
  welcomeTitle?: string | null;
  /** Composer placeholder when session is open. */
  placeholder?: string;
  /** Composer placeholder while the session is still opening. */
  openingPlaceholder?: string;
};

const COMPOSER_SHELL =
  "border-border/60 focus-within:border-border flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)]";

const THREAD_CSS_VARS = {
  ["--thread-max-width" as string]: "44rem",
  ["--composer-bg" as string]:
    "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
  ["--composer-radius" as string]: "1.5rem",
  ["--composer-padding" as string]: "8px",
};

const isEmptyThread = (s: AssistantState) => s.thread.messages.length === 0;

const noop = () => {};

const SLASH_COMMANDS: readonly Unstable_SlashCommand[] = [
  {
    id: "summarize",
    description: "Summarize the conversation",
    icon: "FileText",
    execute: noop,
  },
  {
    id: "search",
    description: "Search the web for information",
    icon: "Globe",
    execute: noop,
  },
  {
    id: "help",
    description: "List available commands",
    icon: "HelpCircle",
    execute: noop,
  },
];

const slashIconMap = {
  FileText: IconFileText,
  Globe: IconWorld,
  HelpCircle: IconHelp,
};

/** Shared chip look for composer (Lexical) and sent user messages. */
const ComposerDirectiveChip: FC<DirectiveChipProps> = ({
  directiveType,
  directiveId,
  label,
}) => {
  const Icon = directiveType === "command" ? IconSlash : IconTool;
  return (
    <Badge
      variant="info"
      size="sm"
      data-slot="directive-text-chip"
      data-directive-type={directiveType}
      data-directive-id={directiveId}
      aria-label={`${directiveType}: ${label}`}
      className="aui-directive-chip mx-0.5 inline-flex translate-y-px items-baseline align-baseline text-[13px] leading-none [&_svg]:self-center"
    >
      <Icon />
      {label}
    </Badge>
  );
};

const UserDirectiveText = createDirectiveText(unstable_defaultDirectiveFormatter, {
  iconMap: {
    command: IconSlash,
    agent: IconTool,
  },
  fallbackIcon: IconTool,
});

/**
 * Reusable assistant-ui chat thread: composer always docked at the bottom,
 * scroll-to-bottom, copy action, and stub attach / voice / @ / / chrome.
 */
export const Thread: FC<ThreadProps> = ({
  sessionOpen = true,
  welcomeTitle = null,
  placeholder = "Send a message... (@ to mention, / for commands)",
  openingPlaceholder = "Agent starting — you can type…",
}) => {
  const isEmpty = useAuiState(isEmptyThread);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background @container"
      style={THREAD_CSS_VARS}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="aui-thread-viewport relative flex min-h-0 flex-1 flex-col scroll-smooth overflow-x-auto overflow-y-scroll"
      >
        <div className="mx-auto flex min-h-full w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          {welcomeTitle != null && (
            <AuiIf condition={isEmptyThread}>
              <ThreadWelcome title={welcomeTitle} sessionOpen={sessionOpen} />
            </AuiIf>
          )}

          {/* Keep status up until the first streamed message — sessionOpen can
              flip true a second before the opening turn produces tokens. */}
          {welcomeTitle == null && isEmpty && (
            <div className="mb-6 flex flex-col items-center px-4 pt-8 text-center">
              <p className="text-sm text-muted-foreground">
                Starting agent session…
              </p>
            </div>
          )}

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? (
                  <UserMessage />
                ) : (
                  <AssistantMessage />
                )
              }
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
            <ThreadScrollToBottom />
            <Composer
              sessionOpen={sessionOpen}
              placeholder={placeholder}
              openingPlaceholder={openingPlaceholder}
            />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

/** Visual twin of {@link Thread} while the runtime / socket is connecting. */
export function ThreadShell({
  placeholder = "Loading…",
}: {
  placeholder?: string;
}) {
  return (
    <div
      className="aui-root aui-thread-root flex h-full min-h-0 flex-1 flex-col bg-background @container"
      style={THREAD_CSS_VARS}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-scroll">
        <div className="mx-auto flex min-h-full w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          <div className="mb-6 flex flex-col items-center px-4 pt-8 text-center">
            <p className="text-sm text-muted-foreground">
              Starting agent session…
            </p>
          </div>
          <div className="sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
            <div className={cn(COMPOSER_SHELL, "opacity-70")}>
              <textarea
                rows={1}
                disabled
                placeholder={placeholder}
                className="max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
              />
              <div className="relative flex items-center justify-between">
                <TooltipIconButton
                  tooltip="Attach file"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon-round"
                  disabled
                  aria-label="Attach file"
                >
                  <IconPaperclip />
                </TooltipIconButton>
                <div className="flex items-center gap-1.5">
                  <TooltipIconButton
                    tooltip="Voice input"
                    side="bottom"
                    type="button"
                    variant="ghost"
                    size="icon-round"
                    disabled
                    aria-label="Voice input"
                  >
                    <IconMicrophone />
                  </TooltipIconButton>
                  <Button
                    type="button"
                    variant="default"
                    size="icon-round"
                    disabled
                    aria-label="Starting session"
                  >
                    <IconLoader2 className="animate-spin" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <IconArrowDown />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC<{ title: string; sessionOpen: boolean }> = ({
  title,
  sessionOpen,
}) => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        {title}
      </h1>
      {!sessionOpen && (
        <p className="mt-2 text-sm text-muted-foreground">
          Starting agent session…
        </p>
      )}
    </div>
  );
};

const Composer: FC<{
  sessionOpen: boolean;
  placeholder: string;
  openingPlaceholder: string;
}> = ({ sessionOpen, placeholder, openingPlaceholder }) => {
  const mention = unstable_useMentionAdapter({
    includeModelContextTools: false,
    items: [
      {
        id: "agent",
        type: "agent",
        label: "Agent",
        description: "Not wired up yet",
        icon: "Tool",
      },
    ],
    iconMap: { Tool: IconTool },
    fallbackIcon: IconTool,
  });
  // Item list from the slash adapter; insert as directives (not Action) so
  // Lexical can chip them. Execute stubs until real commands are wired.
  const slash = unstable_useSlashCommandAdapter({
    commands: SLASH_COMMANDS,
    iconMap: slashIconMap,
    fallbackIcon: IconSlash,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        <div data-slot="aui_composer-shell" className={COMPOSER_SHELL}>
          <LexicalComposerInput
            placeholder={sessionOpen ? placeholder : openingPlaceholder}
            autoFocus
            directiveChip={ComposerDirectiveChip}
            className="aui-composer-input relative max-h-32 min-h-10 w-full overflow-y-auto bg-transparent px-2.5 py-1 text-base caret-primary outline-none"
            aria-label="Message input"
          />
          <ComposerAction sessionOpen={sessionOpen} />
        </div>

        <ComposerTriggerPopover char="@" {...mention} />
        <ComposerTriggerPopover
          char="/"
          adapter={slash.adapter}
          directive={{ formatter: unstable_defaultDirectiveFormatter }}
          iconMap={slash.iconMap}
          fallbackIcon={slash.fallbackIcon}
          emptyItemsLabel="No matching commands"
        />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

const ComposerAction: FC<{ sessionOpen: boolean }> = ({ sessionOpen }) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <TooltipIconButton
        tooltip="Attach file"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon-round"
        disabled
        aria-label="Attach file"
      >
        <IconPaperclip />
      </TooltipIconButton>
      <div className="flex items-center gap-1.5">
        <TooltipIconButton
          tooltip="Voice input"
          side="bottom"
          type="button"
          variant="ghost"
          size="icon-round"
          disabled
          aria-label="Voice input"
        >
          <IconMicrophone />
        </TooltipIconButton>
        {!sessionOpen ? (
          <Button
            type="button"
            variant="default"
            size="icon-round"
            disabled
            aria-label="Starting session"
            title="Starting session…"
          >
            <IconLoader2 className="animate-spin" />
          </Button>
        ) : (
          <>
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <TooltipIconButton
                  tooltip="Send message"
                  side="bottom"
                  type="button"
                  variant="default"
                  size="icon-round"
                  className="aui-composer-send"
                  aria-label="Send message"
                >
                  <IconArrowUp />
                </TooltipIconButton>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel asChild>
                <Button
                  type="button"
                  variant="default"
                  size="icon-round"
                  className="aui-composer-cancel"
                  aria-label="Stop generating"
                >
                  <IconSquare className="fill-current" />
                </Button>
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </>
        )}
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  // Reserve space for the hover action bar without shifting layout.
  const ACTION_BAR_HEIGHT = "min-h-7.5 pt-1.5";

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="px-2 leading-relaxed wrap-break-word text-foreground"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
              case "group-tool":
              case "group-reasoning":
                return <>{children}</>;
              case "text":
                // Separate ACP text segments (e.g. before/after a tool call)
                // need spacing — each MarkdownText zeros its own first/last <p> margin.
                return (
                  <div className="mt-3 first:mt-0">
                    <MarkdownText />
                  </div>
                );
              case "tool-call":
                return part.toolUI ?? null;
              case "data":
                return part.dataRendererUI;
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ms-1 flex gap-1 text-muted-foreground animate-in fade-in duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <IconCheck className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <IconCopy className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer rounded-xl bg-muted px-4 py-2 wrap-break-word text-foreground empty:hidden">
          <MessagePrimitive.Parts components={{ Text: UserDirectiveText }} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};
