import { IconMessage, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ChatThread } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function ChatThreadList({
  threads,
  activeId,
  onNewThread,
  onRename,
  onDelete,
  creating,
}: {
  threads: ChatThread[];
  activeId?: string;
  onNewThread: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  creating?: boolean;
}) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renaming = threads.find((t) => t.id === renameId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Threads</h2>
        <Button
          size="sm"
          onClick={onNewThread}
          disabled={creating}
          aria-label="New Thread"
        >
          <IconPlus data-icon="inline-start" />
          New Thread
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            No threads yet
          </li>
        ) : (
          threads.map((thread) => {
            const active = thread.id === activeId;
            return (
              <li key={thread.id} className="group flex items-center gap-1">
                <Link
                  to={`/chat/${thread.id}`}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-sm",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                  )}
                >
                  <IconMessage className="size-4 shrink-0" />
                  <span className="truncate">
                    {thread.title.trim() || "New Chat"}
                  </span>
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Rename ${thread.title}`}
                  onClick={() => {
                    setRenameId(thread.id);
                    setRenameValue(thread.title);
                  }}
                >
                  <IconPencil />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete ${thread.title}`}
                    >
                      <IconTrash />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this thread?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes the thread and its transcript.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          void onDelete(thread.id);
                        }}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            );
          })
        )}
      </ul>

      <Dialog
        open={renameId !== null}
        onOpenChange={(open) => {
          if (!open) setRenameId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameId && renameValue.trim()) {
                void onRename(renameId, renameValue).then(() => setRenameId(null));
              }
            }}
            autoFocus
            aria-label="Thread title"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameId(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameValue.trim() || !renaming}
              onClick={() => {
                if (!renameId) return;
                void onRename(renameId, renameValue).then(() => setRenameId(null));
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
