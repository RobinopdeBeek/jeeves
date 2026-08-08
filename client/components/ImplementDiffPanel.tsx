import { IconChevronDown, IconFileCode } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { DiffViewer, DiffViewerStats } from "@/components/assistant-ui/diff-viewer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type CardDiffSummary, type DiffFileEntry } from "@/lib/api";
import {
  diffNeedsLoadConfirmation,
  shortSha,
} from "@/lib/implement-diff-view";
import { cn } from "@/lib/utils";

type Props = {
  cardId: string;
};

/**
 * Implement-tab body after a successful run: file list with stats first,
 * lazy per-file DiffViewer patches for `upstream...cardBranch`.
 */
export function ImplementDiffPanel({ cardId }: Props) {
  const [summary, setSummary] = useState<CardDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadConfirmed, setLoadConfirmed] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [patchLoading, setPatchLoading] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSummary(null);
    setLoadConfirmed(false);
    setExpandedPath(null);
    setPatches({});
    setPatchError({});
    api
      .getCardDiff(cardId)
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        if (!diffNeedsLoadConfirmation(data.totalAdditions, data.totalDeletions)) {
          setLoadConfirmed(true);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load diff");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  async function toggleFile(file: DiffFileEntry) {
    if (expandedPath === file.path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(file.path);
    if (patches[file.path] != null || patchError[file.path]) return;
    setPatchLoading(file.path);
    try {
      const { patch } = await api.getCardDiffFile(cardId, file.path);
      setPatches((prev) => ({ ...prev, [file.path]: patch }));
    } catch (err: unknown) {
      setPatchError((prev) => ({
        ...prev,
        [file.path]: err instanceof Error ? err.message : "Failed to load patch",
      }));
    } finally {
      setPatchLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-lg border p-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load changes</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!summary) return null;

  if (summary.files.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconFileCode />
          </EmptyMedia>
          <EmptyTitle>No changes vs upstream</EmptyTitle>
          <EmptyDescription>
            {summary.cardBranch} matches {summary.upstreamRef} (
            {shortSha(summary.baseSha)}…{shortSha(summary.tipSha)})
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const needsConfirm =
    !loadConfirmed &&
    diffNeedsLoadConfirmation(summary.totalAdditions, summary.totalDeletions);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>
            {summary.files.length} file{summary.files.length === 1 ? "" : "s"}
          </span>
          <DiffViewerStats
            additions={summary.totalAdditions}
            deletions={summary.totalDeletions}
          />
        </span>
        <span className="font-mono text-xs">
          {summary.upstreamRef}…{summary.cardBranch}
        </span>
        <span className="font-mono text-xs" title={`${summary.baseSha}…${summary.tipSha}`}>
          {shortSha(summary.baseSha)}…{shortSha(summary.tipSha)}
        </span>
      </div>

      {needsConfirm ? (
        <Alert>
          <AlertTitle>Large diff</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <p>
              This change set has {summary.totalAdditions + summary.totalDeletions}{" "}
              lines across {summary.files.length} files. Loading patches may be slow
              on this device.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setLoadConfirmed(true)}
            >
              Load anyway
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
          <ul className="flex flex-col">
            {summary.files.map((file) => {
              const open = expandedPath === file.path;
              return (
                <li key={file.path} className="border-b last:border-b-0">
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
                    onClick={() => toggleFile(file)}
                  >
                    <IconChevronDown
                      className={cn(
                        "size-4 shrink-0 transition-transform",
                        !open && "-rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {file.oldPath && file.oldPath !== file.path
                        ? `${file.oldPath} → ${file.path}`
                        : file.path}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground capitalize">
                      {file.status}
                    </span>
                    <DiffViewerStats
                      additions={file.additions}
                      deletions={file.deletions}
                    />
                  </button>
                  {open && (
                    <div className="border-t bg-background p-2">
                      {patchLoading === file.path ? (
                        <Skeleton className="h-24 w-full" />
                      ) : patchError[file.path] ? (
                        <p className="px-2 py-1 text-sm text-destructive">
                          {patchError[file.path]}
                        </p>
                      ) : (
                        <DiffViewer
                          patch={patches[file.path] ?? ""}
                          viewMode="unified"
                          size="sm"
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
