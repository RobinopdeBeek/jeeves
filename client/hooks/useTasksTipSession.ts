import { useEffect, useRef, useState } from "react";
import {
  api,
  type Card,
  type TasksDraft,
  type TasksDraftTask,
  type TasksDraftTip,
} from "@/lib/api";

/**
 * Tasks tip session — load / mutate / AI-revision / implement over the tip CRUD seam.
 * UI chrome (tiles, inspector, assist) stays outside this module.
 */
export function useTasksTipSession(opts: {
  cardId: string;
  editable: boolean;
  streaming: boolean;
  displaced: boolean;
  onCardChange: (card: Card) => void;
}) {
  const { cardId, editable, streaming, displaced, onCardChange } = opts;

  const [tip, setTip] = useState<TasksDraft>({ tasks: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionCount, setVersionCount] = useState(0);
  const [implementing, setImplementing] = useState(false);

  const tipRef = useRef(tip);
  tipRef.current = tip;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setVersionCount(0);

    void (async () => {
      try {
        const draft = await api.getTasksDraft(cardId);
        if (cancelled) return;
        setTip({ tasks: draft.tasks });
        setVersionCount(draft.versionCount);
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
  }, [cardId]);

  const mutationsLocked = !editable || busy || streaming || displaced;

  function applyRevision(draft: TasksDraftTip) {
    setTip({ tasks: draft.tasks });
    setVersionCount(draft.versionCount);
    setActionError(null);
  }

  async function refreshTipFromArtifact() {
    try {
      const latest = await api.getTasksDraft(cardId);
      const current = tipRef.current;
      const same =
        latest.tasks.length === current.tasks.length &&
        latest.tasks.every(
          (t, i) =>
            t.id === current.tasks[i]?.id &&
            t.title === current.tasks[i]?.title &&
            t.description === current.tasks[i]?.description &&
            JSON.stringify(t.dependsOn) ===
            JSON.stringify(current.tasks[i]?.dependsOn),
        );
      if (same) {
        setVersionCount(latest.versionCount);
        return;
      }
      applyRevision(latest);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveTasks(tasks: TasksDraftTask[]) {
    if (mutationsLocked) return null;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.putTasksDraft(cardId, { tasks });
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount);
      return saved;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(taskId: string) {
    if (mutationsLocked) return null;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.deleteTasksDraftTask(cardId, taskId);
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount);
      return saved;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (mutationsLocked || versionCount < 2) return null;
    setBusy(true);
    setActionError(null);
    try {
      const next = await api.undoTasksDraft(cardId);
      setTip({ tasks: next.tasks });
      setVersionCount(next.versionCount);
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/nothing to undo/i.test(message)) {
        setVersionCount(1);
      } else {
        setActionError(message);
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  function tipIsValidForImplement(draft: TasksDraft): boolean {
    return (
      draft.tasks.length >= 1 && draft.tasks.every((t) => t.title.trim().length > 0)
    );
  }

  const canImplement =
    editable && !busy && !streaming && !displaced && tipIsValidForImplement(tip);

  async function implement() {
    if (!canImplement || implementing) return;
    setImplementing(true);
    setActionError(null);
    try {
      const updated = await api.implement(cardId);
      onCardChange(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setImplementing(false);
    }
  }

  function liveDraftBody(): string {
    return JSON.stringify({ tasks: tipRef.current.tasks }, null, 2);
  }

  return {
    tip,
    tipRef,
    loaded,
    loadError,
    actionError,
    setActionError,
    busy,
    versionCount,
    mutationsLocked,
    implementing,
    canImplement,
    applyRevision,
    refreshTipFromArtifact,
    saveTasks,
    deleteTask,
    undo,
    implement,
    liveDraftBody,
  };
}
