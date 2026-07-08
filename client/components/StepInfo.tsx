import { useRef } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { StepPanelProps } from "./step-panel-types";

export function StepInfo({ card, onCardChange }: StepPanelProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cardRef = useRef(card);
  cardRef.current = card;

  function autoSave(patch: { title?: string; description?: string }) {
    onCardChange({ ...cardRef.current, ...patch });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateCard(cardRef.current.id, patch).catch(console.error);
    }, 400);
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
    </div>
  );
}
