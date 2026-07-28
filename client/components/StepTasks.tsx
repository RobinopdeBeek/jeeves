import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { nanoid } from "nanoid";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cardTileVariants } from "@/components/ui/pipeline-status";
import { api, type TasksDraft, type TasksDraftTask } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StepPanelProps } from "./step-panel-types";

type InspectorState =
  | { mode: "edit"; taskId: string }
  | { mode: "add"; draft: TasksDraftTask }
  | null;

/**
 * Tasks shaping surface: tip `tasks-draft` tiles + inspector (ADR 0014).
 * Side-chat arrives in slice 7C — the slot is reserved and stacks below on narrow viewports.
 */
export function StepTasks({ card }: StepPanelProps) {
  const tasksStep = card.steps.find((s) => s.key === "tasks");
  const editable = tasksStep?.status === "needs-user";

  const [tip, setTip] = useState<TasksDraft>({ tasks: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionCount, setVersionCount] = useState(0);
  const [redoStack, setRedoStack] = useState<TasksDraft[]>([]);
  const [inspector, setInspector] = useState<InspectorState>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    dependsOn: [] as string[],
  });

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setRedoStack([]);
    setVersionCount(0);

    void (async () => {
      try {
        const draft = await api.getTasksDraft(card.id);
        if (cancelled) return;
        setTip({ tasks: draft.tasks });
        setVersionCount(draft.versionCount ?? 0);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [card.id]);

  function openEdit(task: TasksDraftTask) {
    setActionError(null);
    setInspector({ mode: "edit", taskId: task.id });
    setForm({
      title: task.title,
      description: task.description,
      dependsOn: [...task.dependsOn],
    });
  }

  function openAdd() {
    setActionError(null);
    const draft: TasksDraftTask = {
      id: nanoid(10),
      title: "",
      description: "",
      dependsOn: [],
    };
    setInspector({ mode: "add", draft });
    setForm({ title: "", description: "", dependsOn: [] });
  }

  function closeInspector() {
    setInspector(null);
  }

  async function saveInspector() {
    if (!inspector || busy) return;
    const title = form.title.trim();
    if (!title) {
      setActionError("Title is required");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const task: TasksDraftTask = {
        id: inspector.mode === "add" ? inspector.draft.id : inspector.taskId,
        title,
        description: form.description,
        dependsOn: form.dependsOn,
      };
      const tasks =
        inspector.mode === "add"
          ? [...tip.tasks, task]
          : tip.tasks.map((t) => (t.id === task.id ? task : t));
      const saved = await api.putTasksDraft(card.id, { tasks });
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount ?? versionCount + 1);
      setRedoStack([]);
      closeInspector();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(taskId: string) {
    if (!editable || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.deleteTasksDraftTask(card.id, taskId);
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount ?? versionCount + 1);
      setRedoStack([]);
      if (inspector?.mode === "edit" && inspector.taskId === taskId) {
        closeInspector();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!editable || busy || versionCount < 2) return;
    setBusy(true);
    setActionError(null);
    try {
      const before = tip;
      const next = await api.undoTasksDraft(card.id);
      setTip({ tasks: next.tasks });
      setVersionCount(next.versionCount ?? versionCount + 1);
      setRedoStack((stack) => [...stack, before]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/nothing to undo/i.test(message)) {
        setVersionCount(1);
      } else {
        setActionError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function redo() {
    if (!editable || busy || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.putTasksDraft(card.id, next);
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount ?? versionCount + 1);
      setRedoStack((stack) => stack.slice(0, -1));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function titleById(id: string): string {
    return tip.tasks.find((t) => t.id === id)?.title || id;
  }

  function toggleDepend(id: string) {
    setForm((prev) => ({
      ...prev,
      dependsOn: prev.dependsOn.includes(id)
        ? prev.dependsOn.filter((d) => d !== id)
        : [...prev.dependsOn, id],
    }));
  }

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading Tasks…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  const editingId =
    inspector?.mode === "edit"
      ? inspector.taskId
      : inspector?.mode === "add"
        ? inspector.draft.id
        : null;
  const blockerCandidates = tip.tasks.filter((t) => t.id !== editingId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {editable ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={openAdd} disabled={busy}>
                <IconPlus data-icon="inline-start" />
                Add task
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void undo()}
                disabled={busy || versionCount < 2}
                aria-label="Undo"
              >
                <IconArrowBackUp data-icon="inline-start" />
                Undo
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void redo()}
                disabled={busy || redoStack.length === 0}
                aria-label="Redo"
              >
                <IconArrowForwardUp data-icon="inline-start" />
                Redo
              </Button>
            </div>
          ) : null}

          {tip.tasks.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
              <p className="text-muted-foreground">
                {editable
                  ? "No draft tasks yet. Add one to start shaping the breakdown."
                  : "No draft tasks."}
              </p>
            </div>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {tip.tasks.map((task, index) => (
                <li key={task.id}>
                  <div className="group relative">
                    <button
                      type="button"
                      className={cn(cardTileVariants({ attention: false }), "w-full")}
                      onClick={() => openEdit(task)}
                    >
                      <div className="text-sm font-medium">
                        {index + 1}.{" "}
                        {task.title || (
                          <em className="text-muted-foreground">Untitled task</em>
                        )}
                      </div>
                      {task.dependsOn.length > 0 ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Blocked by{" "}
                          {task.dependsOn.map(titleById).join(", ")}
                        </div>
                      ) : null}
                      {task.description ? (
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {task.description}
                        </div>
                      ) : null}
                    </button>
                    {editable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${task.title || "task"}`}
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteTask(task.id);
                        }}
                      >
                        <IconTrash data-icon="inline-start" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Side-chat slot — slice 7C. Stacked under the list on narrow viewports. */}
        <aside
          className="flex min-h-40 shrink-0 flex-col overflow-hidden rounded-md border bg-background md:w-96"
          aria-label="Tasks assist"
        >
          <div className="border-b px-3 py-2 text-sm font-medium">Jeeves</div>
          <div className="flex flex-1 items-center justify-center p-3 text-center text-sm text-muted-foreground">
            Tasks assist coming soon.
          </div>
        </aside>
      </div>

      <Dialog
        open={inspector !== null}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {inspector?.mode === "add" ? "New task" : "Edit task"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Title</span>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Vertical slice title"
                disabled={!editable || busy}
                autoFocus
              />
            </label>

            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Blocked by</span>
              {blockerCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">No other drafts yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {blockerCandidates.map((t) => {
                    const selected = form.dependsOn.includes(t.id);
                    return (
                      <Button
                        key={t.id}
                        type="button"
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        disabled={!editable || busy}
                        onClick={() => toggleDepend(t.id)}
                      >
                        {t.title || "Untitled"}
                        {selected ? <IconX data-icon="inline-end" /> : null}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Description</span>
              <Textarea
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Acceptance criteria and file hints…"
                rows={6}
                disabled={!editable || busy}
              />
            </label>
          </div>

          <DialogFooter>
            {editable && inspector?.mode === "edit" ? (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                disabled={busy}
                onClick={() => void deleteTask(inspector.taskId)}
              >
                <IconTrash data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={closeInspector}
            >
              {editable ? "Discard" : "Close"}
            </Button>
            {editable ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void saveInspector()}
              >
                Save
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
