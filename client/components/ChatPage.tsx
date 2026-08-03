import { IconMessage } from "@tabler/icons-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** Project Chat stub — full thread UI lands in a follow-on slice. */
export function ChatPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconMessage />
          </EmptyMedia>
          <EmptyTitle>Chat</EmptyTitle>
          <EmptyDescription>Project Chat is coming soon.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
