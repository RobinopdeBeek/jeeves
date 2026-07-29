import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  artifacts,
  type Artifact,
  type ArtifactKind,
} from "../db/schema.js";
import type { StepKey } from "../pipelines.js";
import {
  deleteTaskFromDraft,
  parseTasksDraft,
  type TasksDraft,
  TasksDraftError,
  validateAndNormalizeExchange,
} from "./tasks-draft.js";

export type { UIMessage };
export type { TasksDraft };

const TRANSCRIPT_FILE_ID = "transcript";
const SPEC_FILE_ID = "spec";

function transcriptArtifactId(cardId: string, stepKey: StepKey, round: number): string {
  return `${cardId}-${stepKey}-${round}-transcript`;
}

function specArtifactId(cardId: string, round: number): string {
  return `${cardId}-spec-${round}-spec`;
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export interface HarvestDeclaration {
  exchangePath: string;
  kind: ArtifactKind;
  stepKey: StepKey;
  /** Optional content gate — step policy, not ArtifactStore domain. */
  validate?: (raw: string) => void;
}

export interface HarvestContext {
  cardId: string;
  round: number;
  sourceSkill: string;
  gitSha?: string;
  /**
   * Tasks-draft revise: reuse tip ids from exchange `id` fields when normalizing.
   * Create Tasks / first harvest leave this unset (assign all new ids).
   */
  preserveTasksDraftIds?: boolean;
}

export interface SaveArtifactInput {
  cardId: string;
  stepKey: StepKey;
  round: number;
  kind: ArtifactKind;
  content: string;
  sourceSkill: string;
  gitSha?: string;
  schemaVersion?: number;
}

/**
 * ArtifactStore — file-first storage with a SQLite index (ADR 0007). Only
 * this module resolves artifact paths; every path is containment-checked.
 */
export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly artifactRoot: string,
  ) {}

  save(input: SaveArtifactInput): Artifact {
    const id = nanoid(10);
    const createdAt = new Date();
    const relativePath = this.destinationPath(input.cardId, input.round, input.kind, id);
    const absPath = this.assertUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    const body = withFrontmatter(input.content, {
      cardId: input.cardId,
      step: input.stepKey,
      round: input.round,
      kind: input.kind,
      sourceSkill: input.sourceSkill,
      gitSha: input.gitSha,
      schemaVersion: input.schemaVersion ?? 1,
      createdAt,
    });
    this.writeAtomic(absPath, body);

    const row: Artifact = {
      id,
      cardId: input.cardId,
      stepKey: input.stepKey,
      round: input.round,
      kind: input.kind,
      path: relativePath,
      gitSha: input.gitSha ?? null,
      schemaVersion: input.schemaVersion ?? 1,
      createdAt,
    };
    try {
      this.db.insert(artifacts).values(row).run();
    } catch (error) {
      fs.rmSync(absPath, { force: true });
      throw error;
    }
    this.regenerateManifest(input.cardId);
    return row;
  }

  /**
   * Mutable transcript for ai-chat steps — overwrites the same file and DB row each turn.
   * Stored at `cards/<cardId>/<round>/<stepKey>/transcript.json` so steps do not collide.
   * Caller must assert the step is still mutable (CardStore.assertTranscriptMutable).
   */
  upsertTranscript(
    cardId: string,
    stepKey: StepKey,
    round: number,
    messages: UIMessage[],
  ): Artifact {
    const content = `${JSON.stringify(messages, null, 2)}\n`;
    const existing = this.latest(cardId, { stepKey, round, kind: "transcript" });

    if (existing) {
      const absPath = this.resolveServePath(cardId, existing.path);
      this.writeAtomic(absPath, content);
      this.regenerateManifest(cardId);
      return existing;
    }

    const createdAt = new Date();
    const id = transcriptArtifactId(cardId, stepKey, round);
    // Step-scoped so grill/spec/… each keep their own file (not a shared transcript/ folder).
    const relativePath = path.posix.join(
      "cards",
      cardId,
      String(round),
      stepKey,
      `${TRANSCRIPT_FILE_ID}.json`,
    );
    const absPath = this.assertUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    this.writeAtomic(absPath, content);

    const row: Artifact = {
      id,
      cardId,
      stepKey,
      round,
      kind: "transcript",
      path: relativePath,
      gitSha: null,
      schemaVersion: 1,
      createdAt,
    };
    try {
      this.db.insert(artifacts).values(row).run();
    } catch (error) {
      fs.rmSync(absPath, { force: true });
      throw error;
    }
    this.regenerateManifest(cardId);
    return row;
  }

  /**
   * Append-only versioned tasks-draft JSON tip (ADR 0014).
   * Every Save / Delete / undo / AI harvest writes a new row; `latest` is the tip.
   * Raw JSON — no YAML frontmatter. Caller asserts Tasks mutability.
   */
  appendTasksDraft(
    cardId: string,
    round: number,
    draft: TasksDraft,
    sourceSkill = "human",
  ): Artifact {
    let validated: TasksDraft;
    try {
      validated = parseTasksDraft(draft);
    } catch (err) {
      throw new ArtifactStoreError(
        err instanceof TasksDraftError ? err.message : String(err),
      );
    }
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    const id = nanoid(10);
    const createdAt = new Date();
    const relativePath = this.destinationPath(cardId, round, "tasks-draft", id);
    const absPath = this.assertUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    this.writeAtomic(absPath, content);

    const row: Artifact = {
      id,
      cardId,
      stepKey: "tasks",
      round,
      kind: "tasks-draft",
      path: relativePath,
      gitSha: null,
      schemaVersion: 1,
      createdAt,
    };
    try {
      this.db.insert(artifacts).values(row).run();
    } catch (error) {
      fs.rmSync(absPath, { force: true });
      throw error;
    }
    this.regenerateManifest(cardId);
    return row;
  }

  /** Tip content, or empty draft when no versions exist. */
  readTasksDraftTip(cardId: string, round: number): TasksDraft {
    const tip = this.latest(cardId, {
      stepKey: "tasks",
      round,
      kind: "tasks-draft",
    });
    if (!tip) return { tasks: [] };
    return parseTasksDraft(JSON.parse(this.readContent(tip)));
  }

  /** Number of append-only tasks-draft versions for undo affordances. */
  tasksDraftVersionCount(cardId: string, round: number): number {
    return this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.cardId, cardId),
          eq(artifacts.stepKey, "tasks"),
          eq(artifacts.round, round),
          eq(artifacts.kind, "tasks-draft"),
        ),
      )
      .all().length;
  }

  /**
   * Delete a task from the tip and append the cleaned draft as a new version.
   */
  deleteTaskFromTasksDraft(
    cardId: string,
    round: number,
    taskId: string,
    sourceSkill = "human",
  ): TasksDraft {
    const tip = this.readTasksDraftTip(cardId, round);
    const next = deleteTaskFromDraft(tip, taskId);
    this.appendTasksDraft(cardId, round, next, sourceSkill);
    return this.readTasksDraftTip(cardId, round);
  }

  /**
   * Undo: append a copy of the previous tip. Throws if nothing to undo.
   */
  undoTasksDraft(
    cardId: string,
    round: number,
  ): TasksDraft {
    const previous = this.previousTasksDraft(cardId, round);
    if (!previous) {
      throw new ArtifactStoreError("nothing to undo");
    }
    this.appendTasksDraft(cardId, round, previous.draft, "undo");
    return this.readTasksDraftTip(cardId, round);
  }

  /**
   * Previous tip (second-newest by created_at, then id), if any.
   * Used by undo — prefer undoTasksDraft from routes.
   */
  previousTasksDraft(
    cardId: string,
    round: number,
  ): { artifact: Artifact; draft: TasksDraft } | undefined {
    const versions = this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.cardId, cardId),
          eq(artifacts.stepKey, "tasks"),
          eq(artifacts.round, round),
          eq(artifacts.kind, "tasks-draft"),
        ),
      )
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .all();
    const previous = versions[1];
    if (!previous) return undefined;
    return {
      artifact: previous,
      draft: parseTasksDraft(JSON.parse(this.readContent(previous))),
    };
  }

  /**
   * Fan-out: freeze the tip as `tasks-breakdown` and prune older `tasks-draft`
   * versions for `(card, round)`, keeping the tip draft row/file.
   */
  freezeTasksBreakdown(cardId: string, round: number): Artifact {
    const tip = this.latest(cardId, {
      stepKey: "tasks",
      round,
      kind: "tasks-draft",
    });
    if (!tip) {
      throw new ArtifactStoreError("no tasks-draft tip to freeze");
    }
    const draft = parseTasksDraft(JSON.parse(this.readContent(tip)));
    const content = `${JSON.stringify(draft, null, 2)}\n`;
    const id = nanoid(10);
    const createdAt = new Date();
    const relativePath = this.destinationPath(
      cardId,
      round,
      "tasks-breakdown",
      id,
    );
    const absPath = this.assertUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    this.writeAtomic(absPath, content);

    const row: Artifact = {
      id,
      cardId,
      stepKey: "tasks",
      round,
      kind: "tasks-breakdown",
      path: relativePath,
      gitSha: null,
      schemaVersion: 1,
      createdAt,
    };
    try {
      this.db.insert(artifacts).values(row).run();
    } catch (error) {
      fs.rmSync(absPath, { force: true });
      throw error;
    }

    const older = this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.cardId, cardId),
          eq(artifacts.stepKey, "tasks"),
          eq(artifacts.round, round),
          eq(artifacts.kind, "tasks-draft"),
        ),
      )
      .all()
      .filter((a) => a.id !== tip.id);

    for (const old of older) {
      this.db.delete(artifacts).where(eq(artifacts.id, old.id)).run();
      fs.rmSync(this.assertUnderRoot(old.path), { force: true });
    }

    this.regenerateManifest(cardId);
    return row;
  }

  /**
   * Mutable Spec markdown — overwrites the same file and DB row while Spec is active.
   * Caller must assert the step is still mutable (CardStore.assertSpecMutable).
   * Human PUT, /to-spec harvest, and spec-assist harvest all use this path.
   */
  upsertSpec(
    cardId: string,
    round: number,
    markdown: string,
    sourceSkill = "human",
  ): Artifact {
    const existing = this.latest(cardId, { stepKey: "spec", round, kind: "spec" });
    const createdAt = existing?.createdAt ?? new Date();
    const body = withFrontmatter(markdown, {
      cardId,
      step: "spec",
      round,
      kind: "spec",
      sourceSkill,
      schemaVersion: 1,
      createdAt,
    });

    if (existing) {
      const absPath = this.resolveServePath(cardId, existing.path);
      this.writeAtomic(absPath, body);
      this.regenerateManifest(cardId);
      return existing;
    }

    const id = specArtifactId(cardId, round);
    const relativePath = this.destinationPath(cardId, round, "spec", SPEC_FILE_ID);
    const absPath = this.assertUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    this.writeAtomic(absPath, body);

    const row: Artifact = {
      id,
      cardId,
      stepKey: "spec",
      round,
      kind: "spec",
      path: relativePath,
      gitSha: null,
      schemaVersion: 1,
      createdAt,
    };
    try {
      this.db.insert(artifacts).values(row).run();
    } catch (error) {
      fs.rmSync(absPath, { force: true });
      throw error;
    }
    this.regenerateManifest(cardId);
    return row;
  }

  harvest(
    workspacePath: string,
    declarations: HarvestDeclaration[],
    ctx: HarvestContext,
  ): Artifact[] {
    const harvested: Artifact[] = [];
    for (const decl of declarations) {
      const exchangeAbs = path.resolve(workspacePath, decl.exchangePath);
      if (!fs.existsSync(exchangeAbs)) {
        throw new ArtifactStoreError(`missing required exchange file: ${decl.exchangePath}`);
      }
      const raw = fs.readFileSync(exchangeAbs, "utf8");
      if (!raw.trim()) {
        throw new ArtifactStoreError(`exchange file is empty: ${decl.exchangePath}`);
      }
      if (decl.validate) {
        try {
          decl.validate(raw);
        } catch (err) {
          throw new ArtifactStoreError(
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const content = stripFrontmatter(raw);
      if (decl.kind === "spec") {
        // Spec is mutable within the round (like transcripts) — upsert, don't append.
        harvested.push(
          this.upsertSpec(ctx.cardId, ctx.round, content, ctx.sourceSkill),
        );
      } else if (decl.kind === "tasks-draft") {
        // Append-only tip versions — normalize exchange indices → stable ids.
        let draft: TasksDraft;
        try {
          const previousTip = ctx.preserveTasksDraftIds
            ? this.readTasksDraftTip(ctx.cardId, ctx.round)
            : undefined;
          draft = validateAndNormalizeExchange(
            raw,
            previousTip ? { previousTip } : undefined,
          );
        } catch (err) {
          throw new ArtifactStoreError(
            err instanceof Error ? err.message : String(err),
          );
        }
        harvested.push(
          this.appendTasksDraft(
            ctx.cardId,
            ctx.round,
            draft,
            ctx.sourceSkill,
          ),
        );
      } else {
        harvested.push(
          this.save({
            cardId: ctx.cardId,
            stepKey: decl.stepKey,
            round: ctx.round,
            kind: decl.kind,
            content,
            sourceSkill: ctx.sourceSkill,
            gitSha: ctx.gitSha,
          }),
        );
      }
      fs.rmSync(exchangeAbs, { force: true });
    }
    return harvested;
  }

  list(cardId: string): Artifact[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.cardId, cardId))
      .orderBy(desc(artifacts.createdAt))
      .all();
  }

  latest(
    cardId: string,
    filter: { stepKey: StepKey; round: number; kind: ArtifactKind },
  ): Artifact | undefined {
    return this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.cardId, cardId),
          eq(artifacts.stepKey, filter.stepKey),
          eq(artifacts.round, filter.round),
          eq(artifacts.kind, filter.kind),
        ),
      )
      .orderBy(desc(artifacts.createdAt))
      .get();
  }

  readContent(artifact: Artifact): string {
    const absPath = this.resolveServePath(artifact.cardId, artifact.path);
    return fs.readFileSync(absPath, "utf8");
  }

  /** Body without YAML frontmatter — what the UI renders. */
  readBody(artifact: Artifact): string {
    return stripFrontmatter(this.readContent(artifact)).trim();
  }

  /** Host path for a mutable run log; frozen as a runlog artifact when the run ends. */
  liveLogPath(cardId: string, round: number, runId: string): string {
    const relativePath = path.posix.join(
      "cards",
      cardId,
      String(round),
      `run-${runId}.log`,
    );
    const absPath = this.assertUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    return absPath;
  }

  resolveServePath(cardId: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/");
    const expectedPrefix = `cards/${cardId}/`;
    if (!normalized.startsWith(expectedPrefix) || normalized.includes("..")) {
      throw new ArtifactStoreError("artifact path escapes card folder");
    }
    return this.assertUnderRoot(normalized);
  }

  /** Remove `cards/<cardId>/` under the artifact root (idempotent). */
  removeCardFolder(cardId: string): void {
    if (!cardId || /[/\\]/.test(cardId) || cardId.includes("..")) {
      throw new ArtifactStoreError("invalid card id");
    }
    const absPath = this.assertUnderRoot(path.posix.join("cards", cardId));
    fs.rmSync(absPath, { recursive: true, force: true });
  }

  private destinationPath(
    cardId: string,
    round: number,
    kind: ArtifactKind,
    id: string,
  ): string {
    const ext =
      kind === "eval"
        ? "html"
        : kind === "runlog"
          ? "log"
          : kind === "transcript" ||
              kind === "tasks-draft" ||
              kind === "tasks-breakdown"
            ? "json"
            : "md";
    return path.posix.join("cards", cardId, String(round), kind, `${id}.${ext}`);
  }

  private assertUnderRoot(relativePath: string): string {
    const root = path.resolve(this.artifactRoot);
    const abs = path.resolve(root, relativePath);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ArtifactStoreError("artifact path escapes artifact root");
    }
    return abs;
  }

  private writeAtomic(absPath: string, body: string): void {
    const tmp = `${absPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, absPath);
  }

  private regenerateManifest(cardId: string): void {
    const rows = this.list(cardId);
    const manifest = {
      card_id: cardId,
      artifacts: rows.map((row) => ({
        id: row.id,
        step: row.stepKey,
        round: row.round,
        kind: row.kind,
        path: row.path,
        git_sha: row.gitSha,
        schema_version: row.schemaVersion,
        created_at: row.createdAt.toISOString(),
      })),
    };
    const manifestPath = path.join(this.artifactRoot, "cards", cardId, "manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

interface FrontmatterFields {
  cardId: string;
  step: string;
  round: number;
  kind: string;
  sourceSkill: string;
  gitSha?: string;
  schemaVersion: number;
  createdAt: Date;
}

function withFrontmatter(body: string, fields: FrontmatterFields): string {
  const lines = [
    "---",
    `card_id: ${fields.cardId}`,
    `step: ${fields.step}`,
    `round: ${fields.round}`,
    `kind: ${fields.kind}`,
    `source_skill: ${fields.sourceSkill}`,
    ...(fields.gitSha ? [`git_sha: ${fields.gitSha}`] : []),
    `schema_version: ${fields.schemaVersion}`,
    `created_at: ${fields.createdAt.toISOString()}`,
    "---",
    "",
    body.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}
