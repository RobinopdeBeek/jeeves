import { useEffect, useRef, useState } from "react";
import { IconPaperclip, IconPlus, IconTrash } from "@tabler/icons-react";
import {
  CARD_LIBRARY_ATTACHMENT_ACCEPT,
  isCardLibraryAttachmentAllowed,
} from "@shared/attachment-refs";
import { api, type CardAttachment } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { StepPanelProps } from "./step-panel-types";

export function StepInfo({ card, onCardChange }: StepPanelProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cardRef = useRef(card);
  cardRef.current = card;

  const [attachments, setAttachments] = useState<CardAttachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(true);
  const instructionTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingAttachments(true);
    api
      .listCardAttachments(card.id)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoadingAttachments(false);
      });
    return () => {
      cancelled = true;
      for (const t of instructionTimers.current.values()) clearTimeout(t);
      instructionTimers.current.clear();
    };
  }, [card.id]);

  function autoSave(patch: { title?: string; description?: string }) {
    onCardChange({ ...cardRef.current, ...patch });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateCard(cardRef.current.id, patch).catch(console.error);
    }, 400);
  }

  function patchInstructionLocal(id: string, instruction: string) {
    setAttachments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, instruction } : a)),
    );
    const timers = instructionTimers.current;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        api
          .updateCardAttachmentInstruction(card.id, id, instruction)
          .catch(console.error);
      }, 400),
    );
  }

  async function onAddFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (!isCardLibraryAttachmentAllowed(file.type, file.name)) {
        console.error(
          `Unsupported attachment type "${file.type || "(unknown)"}" for "${file.name}".`,
        );
        continue;
      }
      try {
        const created = await api.addCardAttachment(card.id, file, {
          originStep: "info",
        });
        setAttachments((prev) => [...prev, created]);
      } catch (e) {
        console.error(e);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onDeleteAttachment(attachmentId: string) {
    try {
      await api.deleteCardAttachment(card.id, attachmentId);
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="card-title" className="text-sm font-medium">
          Title
        </label>
        <Input
          id="card-title"
          value={card.title}
          placeholder="What should be built?"
          onChange={(e) => autoSave({ title: e.target.value })}
        />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <label htmlFor="card-desc" className="text-sm font-medium">
          Description
        </label>
        <Textarea
          id="card-desc"
          value={card.description}
          placeholder="Describe the idea in markdown…"
          className="flex-1 resize-none"
          onChange={(e) => autoSave({ description: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium">Attachments</label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <IconPlus data-icon="inline-start" />
            Add file
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept={CARD_LIBRARY_ATTACHMENT_ACCEPT}
            onChange={(e) => void onAddFiles(e.target.files)}
          />
        </div>
        {loadingAttachments ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No attachments yet. Add reference files for this card.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {attachments.map((att) => (
              <li key={att.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <IconPaperclip className="size-4 shrink-0" />
                  <a
                    href={api.cardAttachmentUrl(card.id, att.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-sm underline-offset-4 hover:underline"
                  >
                    {att.filename}
                  </a>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${att.filename}`}
                    onClick={() => void onDeleteAttachment(att.id)}
                  >
                    <IconTrash />
                  </Button>
                </div>
                <Textarea
                  value={att.instruction}
                  placeholder="How should later steps use this file?"
                  className="min-h-16 resize-none"
                  onChange={(e) =>
                    patchInstructionLocal(att.id, e.target.value)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
