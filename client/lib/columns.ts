import type { ColumnId } from "./api";

export interface ColumnDef {
  id: ColumnId;
  name: string;
  short: string;
  sub: string;
}

export const COLUMNS: ColumnDef[] = [
  { id: "backlog", name: "Backlog", short: "Backlog", sub: "The dumping ground" },
  { id: "define", name: "Define", short: "Define", sub: "Grill → Spec → Tasks" },
  { id: "implement", name: "Implement", short: "Implement", sub: "Plan → Implement → AI Review" },
  { id: "review", name: "Review", short: "Review", sub: "Interactive evaluation" },
  { id: "finalize", name: "Finalize", short: "Finalize", sub: "Document → Deploy" },
];
