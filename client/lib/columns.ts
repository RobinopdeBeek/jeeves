import type { ColumnId } from "./api";

export interface ColumnDef {
  id: ColumnId;
  name: string;
  short: string;
  sub: string;
}

export const COLUMNS: ColumnDef[] = [
  { id: "backlog", name: "Backlog", short: "Backlog", sub: "Captured ideas, not started" },
  { id: "define", name: "Define Feature", short: "Define", sub: "Features: Grill → PRD → Tasks" },
  { id: "implement", name: "Implement Task", short: "Implement", sub: "Tasks: Plan → Implement → AI Review" },
  { id: "review", name: "Human Review", short: "Review", sub: "Your call before merge" },
  { id: "finalize", name: "Finalize", short: "Finalize", sub: "Document → Deploy" },
];
