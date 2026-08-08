import { sqliteTable, text, integer, real, unique, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
  /** Set = child task of that feature; null task = standalone (ADR 0004). */
  parentCardId: text("parent_card_id").references((): AnySQLiteColumn => cards.id),
  // null while the card sits in Backlog with its kind undecided
  kind: text("kind", { enum: ["feature", "task"] }),
  // No shaping `draft` — Tasks tip is a versioned artifact (ADR 0014).
  status: text("status", {
    enum: ["active", "merged", "done"],
  }).notNull(),
  column: text("column", {
    enum: ["backlog", "define", "implement", "review", "finalize"],
  }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  /** Feature/task git branch — nullable until slice 8 creates them. */
  branch: text("branch"),
  position: integer("position").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Blocked-by edges between active cards (after fan-out). */
export const cardBlockers = sqliteTable(
  "card_blockers",
  {
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    blocksOnCardId: text("blocks_on_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
  },
  (t) => [unique().on(t.cardId, t.blocksOnCardId)],
);

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
      enum: [
        "pending",
        "queued",
        "ai-working",
        "needs-user",
        "awaiting",
        "done",
      ],
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
  /** Exact ref the worktree was created from — replayed on retry. */
  baseSha: text("base_sha"),
});

export const artifactKinds = [
  "grill",
  "spec",
  "tasks-draft",
  "tasks-breakdown",
  "plan",
  "eval",
  "screenshot",
  "runlog",
  "attachment",
  "transcript",
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

/** Project Chat threads — index rows; transcript files live under chatRoot (ADR 0015). */
export const chatThreads = sqliteTable("chat_threads", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  /** Cursor model id for this thread; null until the model picker lands. */
  model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  lastOpenedAt: integer("last_opened_at", { mode: "timestamp_ms" }),
});

/**
 * Card attachment library (Info / Backlog inputs) — SQL metadata + instruction;
 * bytes live under `data/cards/<cardId>/attachments/` (ADR 0017 Phase 2).
 * Distinct from chat-turn sidecars and from artifact `kind: "attachment"`.
 */
export const cardAttachments = sqliteTable("card_attachments", {
  id: text("id").primaryKey(),
  cardId: text("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  /** Store-relative path under artifact root, e.g. cards/<id>/attachments/<id>-name. */
  path: text("path").notNull(),
  /** Per-file instruction for downstream steps; empty string when unset. */
  instruction: text("instruction").notNull().default(""),
  originStep: text("origin_step", {
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
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Project = typeof projects.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type CardStep = typeof cardSteps.$inferSelect;
export type CardBlocker = typeof cardBlockers.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type ArtifactKind = (typeof artifactKinds)[number];
export type ChatThread = typeof chatThreads.$inferSelect;
export type CardAttachment = typeof cardAttachments.$inferSelect;
