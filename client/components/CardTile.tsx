import { useNavigate } from "react-router-dom";
import type { Card } from "@/lib/api";

export function CardTile({ card }: { card: Card }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/cards/${card.id}`)}
      className="rounded-lg border bg-card p-3 text-left shadow-xs transition-colors hover:bg-accent"
    >
      <div className="text-sm font-medium">
        {card.title || <em className="text-muted-foreground">Untitled</em>}
      </div>
      {card.description ? (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.description}</div>
      ) : (
        <div className="mt-1 text-xs italic text-muted-foreground">No description</div>
      )}
    </button>
  );
}
