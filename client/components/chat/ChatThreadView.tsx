import { IconArrowLeft, IconMessage } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import type { ChatThread } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** Empty Project Chat shell — live ACP streaming lands in a follow-on slice. */
export function ChatThreadView({
  thread,
  showBack,
}: {
  thread: ChatThread | null;
  showBack?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {showBack ? (
          <Button variant="ghost" size="icon-sm" asChild aria-label="Back to threads">
            <Link to="/chat">
              <IconArrowLeft data-icon="inline-start" />
            </Link>
          </Button>
        ) : null}
        <h1 className="truncate text-sm font-medium">
          {thread?.title.trim() || "Chat"}
        </h1>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconMessage />
            </EmptyMedia>
            <EmptyTitle>{thread?.title.trim() || "New Chat"}</EmptyTitle>
            <EmptyDescription>
              Send a message once live Project Chat is wired up.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  );
}
