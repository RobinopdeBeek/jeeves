import { IconFolder } from "@tabler/icons-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** Files placeholder — reserves the nav destination until the explorer lands. */
export function FilesPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconFolder />
          </EmptyMedia>
          <EmptyTitle>Files</EmptyTitle>
          <EmptyDescription>No files to show yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
