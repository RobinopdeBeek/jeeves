import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";

// Drizzle schema — column source of truth. Slice 2 adds card_steps;
// later slices add runs, artifacts, ... via migrations.

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

export const cardSteps = sqliteTable(
  "card_steps",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    stepKey: text("step_key", {
      enum: [
        "info",
        "grill",
        "spec",
        "tasks",
        "plan",
        "impl",
        "airev",
        "review",
        "document",
        "deploy",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "queued", "ai-working", "needs-user", "done"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [unique().on(t.cardId, t.stepKey)],
);

// One row per skill invocation. Failure lives here (`failed`) — the step
// itself only goes to `needs-user`; the UI distinguishes by latest run status.
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  cardId: text("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  stepKey: text("step_key").notNull(),
  round: integer("round").notNull().default(0),
  skill: text("skill").notNull(),
  status: text("status", {
    enum: ["running", "succeeded", "failed"],
  }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  model: text("model"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  cost: real("cost"),
  error: text("error"),
  logPath: text("log_path"),
});

export const artifactKinds = [
  "grill",
  "spec",
  "tasks-breakdown",
  "plan",
  "eval",
  "screenshot",
  "runlog",
  "attachment",
] as const;

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  cardId: text("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  stepKey: text("step_key").notNull(),
  round: integer("round").notNull(),
  kind: text("kind", { enum: artifactKinds }).notNull(),
  path: text("path").notNull(),
  gitSha: text("git_sha"),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Project = typeof projects.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type CardStep = typeof cardSteps.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type ArtifactKind = (typeof artifactKinds)[number];
