import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Slice-1 schema: only projects + cards, only the columns the walking
// skeleton uses. Later slices add card_steps, runs, artifacts, ... via
// migrations (see jeeves-plan.md "Data Model" for the full shape).

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const cards = sqliteTable("cards", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  // null while the card sits in Backlog with its kind undecided
  kind: text("kind", { enum: ["feature", "task"] }),
  status: text("status", {
    enum: ["draft", "active", "merged", "done"],
  }).notNull(),
  column: text("column", {
    enum: ["backlog", "define", "implement", "review", "finalize"],
  }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  position: integer("position").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Project = typeof projects.$inferSelect;
export type Card = typeof cards.$inferSelect;
