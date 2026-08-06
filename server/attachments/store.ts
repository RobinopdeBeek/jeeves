/**
 * On-disk sidecar I/O for chat / step-chat user attachments (ADR 0017).
 *
 * Pointer scheme and layout are documented in `shared/attachment-refs.ts`.
 * This module owns write/read/resolve + path containment; routes and
 * ChatSession adapters stay thin.
 */
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  formatChatAttachmentPointer,
  formatStepAttachmentPointer,
  guessTextMediaType,
  isCardLibraryAttachmentAllowed,
  isDataUrl,
  parseAttachmentPointer,
  type AttachmentPointer,
} from "../../shared/attachment-refs.js";
import type { ChatAttachment } from "../../shared/prompt-capabilities.js";

export class AttachmentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

const DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]+)$/i;

export type AttachmentOwner =
  | { kind: "chat"; chatRoot: string; threadId: string }
  | {
      kind: "step";
      artifactRoot: string;
      cardId: string;
      stepKey: string;
    };

export type ResolvedAttachmentBytes = {
  mimeType: string;
  /** Raw base64 (no data: prefix). */
  data: string;
  filename?: string;
  bytes: Buffer;
};

/** Strip path separators and reserved characters from a display filename. */
export function safeAttachmentFilename(filename: string | undefined): string {
  const base = (filename?.trim() || "attachment").split(/[/\\]/).pop() ?? "attachment";
  const cleaned = base.replace(/[^\w.\-()+ ]+/g, "_").replace(/\s+/g, " ").trim();
  const clipped = cleaned.slice(0, 120);
  return clipped || "attachment";
}

function parseDataUrlPayload(url: string): { mimeType: string; bytes: Buffer } {
  const match = DATA_URL_RE.exec(url.trim());
  if (!match) {
    throw new AttachmentStoreError("Attachment must be a base64 data URL.");
  }
  return {
    mimeType: match[1]!.toLowerCase(),
    bytes: Buffer.from(match[2]!, "base64"),
  };
}

function assertSafeId(id: string, label: string): string {
  if (!id || /[/\\]/.test(id) || id.includes("..") || id.includes("\0")) {
    throw new AttachmentStoreError(`invalid ${label}`);
  }
  return id;
}

function assertUnderRoot(root: string, absPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absPath);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AttachmentStoreError("attachment path escapes store root");
  }
  return resolved;
}

export function chatAttachmentsDir(chatRoot: string, threadId: string): string {
  assertSafeId(threadId, "thread id");
  return path.join(path.resolve(chatRoot), threadId, "attachments");
}

export function stepAttachmentsDir(
  artifactRoot: string,
  cardId: string,
  stepKey: string,
): string {
  assertSafeId(cardId, "card id");
  assertSafeId(stepKey, "step key");
  return path.join(
    path.resolve(artifactRoot),
    "cards",
    cardId,
    "chat-attachments",
    stepKey,
  );
}

/**
 * Card library attachments (Info / Backlog) — distinct from step-chat
 * `chat-attachments/` turn sidecars.
 */
export function cardLibraryAttachmentsDir(
  artifactRoot: string,
  cardId: string,
): string {
  assertSafeId(cardId, "card id");
  return path.join(path.resolve(artifactRoot), "cards", cardId, "attachments");
}

/** Store-relative posix path for a card-library sidecar file. */
export function cardLibraryAttachmentRelativePath(
  cardId: string,
  attachmentId: string,
  safeName: string,
): string {
  assertSafeId(cardId, "card id");
  assertSafeId(attachmentId, "attachment id");
  return path.posix.join(
    "cards",
    cardId,
    "attachments",
    `${attachmentId}-${safeName}`,
  );
}

/** Re-export path containment for card-library / route helpers. */
export function assertAttachmentPathUnderRoot(
  root: string,
  absPath: string,
): string {
  return assertUnderRoot(root, absPath);
}

function ownerDir(owner: AttachmentOwner): string {
  if (owner.kind === "chat") {
    return chatAttachmentsDir(owner.chatRoot, owner.threadId);
  }
  return stepAttachmentsDir(owner.artifactRoot, owner.cardId, owner.stepKey);
}

function pointerFor(
  owner: AttachmentOwner,
  attachmentId: string,
): string {
  if (owner.kind === "chat") {
    return formatChatAttachmentPointer(owner.threadId, attachmentId);
  }
  return formatStepAttachmentPointer(
    owner.cardId,
    owner.stepKey,
    attachmentId,
  );
}

/** Absolute path to a sidecar file, or null when missing. */
export function findAttachmentFile(
  dir: string,
  attachmentId: string,
): string | null {
  assertSafeId(attachmentId, "attachment id");
  if (!fs.existsSync(dir)) return null;
  const prefix = `${attachmentId}-`;
  const matches = fs
    .readdirSync(dir)
    .filter((name) => name === attachmentId || name.startsWith(prefix));
  if (matches.length === 0) return null;
  matches.sort();
  return assertUnderRoot(dir, path.join(dir, matches[0]!));
}

export function absolutePathForPointer(
  pointer: AttachmentPointer,
  roots: { chatRoot: string; artifactRoot: string },
): string {
  if (pointer.kind === "chat") {
    const dir = chatAttachmentsDir(roots.chatRoot, pointer.threadId);
    const found = findAttachmentFile(dir, pointer.attachmentId);
    if (!found) {
      throw new AttachmentStoreError("attachment not found");
    }
    return found;
  }
  const dir = stepAttachmentsDir(
    roots.artifactRoot,
    pointer.cardId,
    pointer.stepKey,
  );
  const found = findAttachmentFile(dir, pointer.attachmentId);
  if (!found) {
    throw new AttachmentStoreError("attachment not found");
  }
  return found;
}

/**
 * Write raw bytes to a chat/step sidecar and return a pointer ChatAttachment.
 * Shared by REST upload and legacy data:-URL materialize.
 */
export function writeAttachmentBytes(
  owner: AttachmentOwner,
  input: {
    filename?: string;
    mediaType?: string;
    bytes: Buffer;
  },
): ChatAttachment {
  if (!input.bytes.length) {
    throw new AttachmentStoreError("attachment body is empty");
  }
  const filename = safeAttachmentFilename(input.filename);
  const mediaType =
    input.mediaType?.trim() ||
    guessTextMediaType(input.filename) ||
    "application/octet-stream";
  if (!isCardLibraryAttachmentAllowed(mediaType, filename)) {
    throw new AttachmentStoreError(
      `Unsupported attachment type "${mediaType}" for "${filename}". ` +
        "Supported: images and text files (md, txt, json, yaml, csv, …).",
    );
  }
  const attachmentId = nanoid(10);
  const dir = ownerDir(owner);
  fs.mkdirSync(dir, { recursive: true });
  const absPath = assertUnderRoot(
    dir,
    path.join(dir, `${attachmentId}-${filename}`),
  );
  fs.writeFileSync(absPath, input.bytes);
  return {
    mediaType,
    url: pointerFor(owner, attachmentId),
    ...(input.filename != null ? { filename: input.filename } : { filename }),
  };
}

/**
 * Rewrite a live/legacy `data:` URL attachment to a sidecar pointer.
 * No-op when `url` is already a pointer.
 */
export function materializeAttachment(
  owner: AttachmentOwner,
  att: ChatAttachment,
): ChatAttachment {
  if (!isDataUrl(att.url)) {
    return att;
  }
  const { mimeType, bytes } = parseDataUrlPayload(att.url);
  return writeAttachmentBytes(owner, {
    filename: att.filename,
    mediaType:
      att.mediaType.trim() ||
      mimeType ||
      guessTextMediaType(att.filename) ||
      "application/octet-stream",
    bytes,
  });
}

export function materializeAttachments(
  owner: AttachmentOwner,
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  return attachments.map((att) => materializeAttachment(owner, att));
}

function bytesFromFile(
  absPath: string,
  att: ChatAttachment,
): ResolvedAttachmentBytes {
  const bytes = fs.readFileSync(absPath);
  const mediaType =
    att.mediaType.trim() ||
    guessTextMediaType(att.filename) ||
    "application/octet-stream";
  return {
    mimeType: mediaType,
    data: bytes.toString("base64"),
    bytes,
    ...(att.filename != null ? { filename: att.filename } : {}),
  };
}

/** Resolve a data: URL or pointer owned by this chat/step session. */
export function resolveAttachmentBytesForOwner(
  owner: AttachmentOwner,
  att: ChatAttachment,
): ResolvedAttachmentBytes {
  if (isDataUrl(att.url)) {
    const { mimeType, bytes } = parseDataUrlPayload(att.url);
    return {
      mimeType: att.mediaType.trim() || mimeType,
      data: bytes.toString("base64"),
      bytes,
      ...(att.filename != null ? { filename: att.filename } : {}),
    };
  }
  const pointer = parseAttachmentPointer(att.url);
  if (!pointer) {
    throw new AttachmentStoreError(
      "Attachment must be a data URL or jeeves-attachment pointer.",
    );
  }
  if (owner.kind === "chat") {
    if (pointer.kind !== "chat" || pointer.threadId !== owner.threadId) {
      throw new AttachmentStoreError("attachment pointer does not match chat owner");
    }
    const found = findAttachmentFile(
      chatAttachmentsDir(owner.chatRoot, owner.threadId),
      pointer.attachmentId,
    );
    if (!found) throw new AttachmentStoreError("attachment not found");
    return bytesFromFile(found, att);
  }
  if (
    pointer.kind !== "step" ||
    pointer.cardId !== owner.cardId ||
    pointer.stepKey !== owner.stepKey
  ) {
    throw new AttachmentStoreError("attachment pointer does not match step owner");
  }
  const found = findAttachmentFile(
    stepAttachmentsDir(owner.artifactRoot, owner.cardId, owner.stepKey),
    pointer.attachmentId,
  );
  if (!found) throw new AttachmentStoreError("attachment not found");
  return bytesFromFile(found, att);
}

/** Resolve a data: URL or jeeves-attachment pointer to bytes + base64. */
export function resolveAttachmentBytes(
  att: ChatAttachment,
  roots: { chatRoot: string; artifactRoot: string },
): ResolvedAttachmentBytes {
  if (isDataUrl(att.url)) {
    return resolveAttachmentBytesForOwner(
      { kind: "chat", chatRoot: roots.chatRoot, threadId: "_" },
      att,
    );
  }
  const pointer = parseAttachmentPointer(att.url);
  if (!pointer) {
    throw new AttachmentStoreError(
      "Attachment must be a data URL or jeeves-attachment pointer.",
    );
  }
  const absPath = absolutePathForPointer(pointer, roots);
  return bytesFromFile(absPath, att);
}

/** Content-Type sniff for serve routes (extension-first, then octet-stream). */
export function contentTypeForAttachmentFile(
  absPath: string,
  fallbackMediaType?: string,
): string {
  if (fallbackMediaType?.trim()) return fallbackMediaType.trim();
  const guessed = guessTextMediaType(path.basename(absPath));
  if (guessed) return guessed;
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
