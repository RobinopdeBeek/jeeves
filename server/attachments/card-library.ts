/**
 * Card attachment library — first-class card inputs (ADR 0017 Phase 2).
 *
 * Bytes: `data/cards/<cardId>/attachments/<id>-<safeName>`
 * Metadata + per-file instruction: SQLite `card_attachments`.
 *
 * Distinct from chat/step turn sidecars and from execution
 * `kind: "attachment"` failure diagnostics.
 */
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import {
  cardAttachments,
  type CardAttachment,
} from "../db/schema.js";
import { isStepKey, type StepKey } from "../pipelines.js";
import {
  assertAttachmentPathUnderRoot,
  AttachmentStoreError,
  cardLibraryAttachmentRelativePath,
  contentTypeForAttachmentFile,
  safeAttachmentFilename,
} from "./store.js";
import {
  guessTextMediaType,
  isCardLibraryAttachmentAllowed,
} from "../../shared/attachment-refs.js";

export class CardAttachmentStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CardAttachmentStoreError";
  }
}

export type CardAttachmentView = {
  id: string;
  cardId: string;
  filename: string;
  mediaType: string;
  path: string;
  instruction: string;
  originStep: StepKey;
  sizeBytes: number;
  createdAt: string;
};

export type AddCardAttachmentInput = {
  cardId: string;
  filename?: string;
  mediaType?: string;
  bytes: Buffer;
  instruction?: string;
  originStep?: StepKey;
};

function toView(row: CardAttachment): CardAttachmentView {
  return {
    id: row.id,
    cardId: row.cardId,
    filename: row.filename,
    mediaType: row.mediaType,
    path: row.path,
    instruction: row.instruction,
    originStep: row.originStep as StepKey,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

export class CardAttachmentStore {
  constructor(
    private readonly db: Db,
    private readonly artifactRoot: string,
  ) {}

  get root(): string {
    return this.artifactRoot;
  }

  list(cardId: string): CardAttachmentView[] {
    return this.db
      .select()
      .from(cardAttachments)
      .where(eq(cardAttachments.cardId, cardId))
      .orderBy(asc(cardAttachments.createdAt))
      .all()
      .map(toView);
  }

  get(cardId: string, attachmentId: string): CardAttachmentView | null {
    const row = this.db
      .select()
      .from(cardAttachments)
      .where(
        and(
          eq(cardAttachments.cardId, cardId),
          eq(cardAttachments.id, attachmentId),
        ),
      )
      .get();
    return row ? toView(row) : null;
  }

  add(input: AddCardAttachmentInput): CardAttachmentView {
    const originStep = input.originStep ?? "info";
    if (!isStepKey(originStep)) {
      throw new CardAttachmentStoreError(400, "invalid origin step");
    }
    if (!input.bytes.length) {
      throw new CardAttachmentStoreError(400, "attachment body is empty");
    }

    const id = nanoid(10);
    const filename = safeAttachmentFilename(input.filename);
    const mediaType =
      input.mediaType?.trim() ||
      guessTextMediaType(input.filename) ||
      "application/octet-stream";
    if (!isCardLibraryAttachmentAllowed(mediaType, filename)) {
      throw new CardAttachmentStoreError(
        400,
        `Unsupported attachment type "${mediaType}" for "${filename}". ` +
          "Supported: images and text files (md, txt, json, yaml, csv, …).",
      );
    }
    const relativePath = cardLibraryAttachmentRelativePath(
      input.cardId,
      id,
      filename,
    );
    const absPath = this.resolveUnderRoot(relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, input.bytes);

    const row: CardAttachment = {
      id,
      cardId: input.cardId,
      filename,
      mediaType,
      path: relativePath,
      instruction: input.instruction?.trim() ?? "",
      originStep,
      sizeBytes: input.bytes.length,
      createdAt: new Date(),
    };
    try {
      this.db.insert(cardAttachments).values(row).run();
    } catch (error) {
      fs.rmSync(absPath, { force: true });
      throw error;
    }
    return toView(row);
  }

  updateInstruction(
    cardId: string,
    attachmentId: string,
    instruction: string,
  ): CardAttachmentView | null {
    if (typeof instruction !== "string") {
      throw new CardAttachmentStoreError(400, "instruction must be a string");
    }
    const existing = this.get(cardId, attachmentId);
    if (!existing) return null;
    this.db
      .update(cardAttachments)
      .set({ instruction })
      .where(
        and(
          eq(cardAttachments.cardId, cardId),
          eq(cardAttachments.id, attachmentId),
        ),
      )
      .run();
    return this.get(cardId, attachmentId);
  }

  delete(cardId: string, attachmentId: string): boolean {
    const row = this.db
      .select()
      .from(cardAttachments)
      .where(
        and(
          eq(cardAttachments.cardId, cardId),
          eq(cardAttachments.id, attachmentId),
        ),
      )
      .get();
    if (!row) return false;

    const absPath = this.resolveUnderRoot(row.path);
    this.db
      .delete(cardAttachments)
      .where(
        and(
          eq(cardAttachments.cardId, cardId),
          eq(cardAttachments.id, attachmentId),
        ),
      )
      .run();
    fs.rmSync(absPath, { force: true });
    return true;
  }

  /** Absolute path to bytes for a library attachment, or null if missing. */
  absolutePath(cardId: string, attachmentId: string): string | null {
    const row = this.db
      .select()
      .from(cardAttachments)
      .where(
        and(
          eq(cardAttachments.cardId, cardId),
          eq(cardAttachments.id, attachmentId),
        ),
      )
      .get();
    if (!row) return null;
    const absPath = this.resolveUnderRoot(row.path);
    if (!fs.existsSync(absPath)) return null;
    return absPath;
  }

  contentType(cardId: string, attachmentId: string): string {
    const meta = this.get(cardId, attachmentId);
    const abs = this.absolutePath(cardId, attachmentId);
    if (!abs) {
      throw new CardAttachmentStoreError(404, "attachment not found");
    }
    return contentTypeForAttachmentFile(abs, meta?.mediaType);
  }

  private resolveUnderRoot(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/");
    if (normalized.includes("..") || path.isAbsolute(normalized)) {
      throw new AttachmentStoreError("attachment path escapes store root");
    }
    return assertAttachmentPathUnderRoot(
      this.artifactRoot,
      path.resolve(this.artifactRoot, normalized),
    );
  }
}
