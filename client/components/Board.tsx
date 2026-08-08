import { IconPlus } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Card, type ColumnId } from "@/lib/api";
import { COLUMNS } from "@/lib/columns";
import { useJeevesEvents } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CardTile } from "./CardTile";

const MOBILE_MQ = "(max-width: 767px)";

export function Board() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[]>([]);
  const [activeCol, setActiveCol] = useState<ColumnId>("backlog");
  const scrollerRef = useRef<HTMLElement>(null);
  const columnRefs = useRef(new Map<ColumnId, HTMLElement>());

  useEffect(() => {
    api.listCards().then(setCards).catch(console.error);
  }, []);

  useJeevesEvents(
    (event) => {
      if (event.type !== "card.updated") return;
      setCards((prev) => {
        const exists = prev.some((c) => c.id === event.card.id);
        return exists
          ? prev.map((c) => (c.id === event.card.id ? event.card : c))
          : [...prev, event.card];
      });
    },
    // SSE reconnect may have missed card.updated events during the gap.
    () => api.listCards().then(setCards).catch(console.error),
  );

  // Keep the bottom nav highlight in sync with the snapped column (mobile only).
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const syncActive = () => {
      if (!window.matchMedia(MOBILE_MQ).matches) return;
      const width = root.clientWidth;
      if (width <= 0) return;
      const index = Math.round(root.scrollLeft / width);
      const col = COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, index))];
      if (col) setActiveCol(col.id);
    };

    root.addEventListener("scroll", syncActive, { passive: true });
    root.addEventListener("scrollend", syncActive);
    return () => {
      root.removeEventListener("scroll", syncActive);
      root.removeEventListener("scrollend", syncActive);
    };
  }, []);

  async function addCard() {
    const card = await api.createCard();
    navigate(`/cards/${card.id}`);
  }

  function goToColumn(id: ColumnId) {
    setActiveCol(id);
    const el = columnRefs.current.get(id);
    el?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }

  const cardsIn = (col: ColumnId) => cards.filter((c) => c.column === col);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <main
        ref={scrollerRef}
        className={cn(
          "flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden",
          "max-md:snap-x max-md:snap-mandatory max-md:scroll-smooth",
          "md:gap-3 md:p-3",
        )}
      >
        {COLUMNS.map((col) => (
          <section
            key={col.id}
            ref={(el) => {
              if (el) columnRefs.current.set(col.id, el);
              else columnRefs.current.delete(col.id);
            }}
            data-column-id={col.id}
            className={cn(
              "flex w-[19rem] shrink-0 flex-col rounded-lg border bg-secondary/40",
              // Mobile: full-viewport slides that snap; desktop: fixed-width lanes.
              "max-md:w-full max-md:basis-full max-md:snap-start max-md:snap-always",
              "max-md:rounded-none max-md:border-x-0 max-md:border-t-0",
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <div>
                <div className="text-sm font-semibold">{col.name}</div>
                <div className="text-xs text-muted-foreground">{col.sub}</div>
              </div>
              {col.id === "backlog" && (
                <Button variant="outline" size="sm" onClick={addCard}>
                  <IconPlus data-icon="inline-start" /> Add card
                </Button>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
              {cardsIn(col.id).length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">No cards</div>
              ) : (
                cardsIn(col.id).map((card) => <CardTile key={card.id} card={card} />)
              )}
            </div>
          </section>
        ))}
      </main>

      <nav className="flex shrink-0 border-t bg-background md:hidden">
        {COLUMNS.map((col) => (
          <button
            key={col.id}
            type="button"
            onClick={() => goToColumn(col.id)}
            aria-current={col.id === activeCol ? "true" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
              col.id === activeCol ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            <span>{col.short}</span>
            <span className="rounded-full bg-secondary px-1.5 text-[10px]">
              {cardsIn(col.id).length}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}
