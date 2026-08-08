/**
 * Chat / step-chat attachment pointer scheme (Phase 1 sidecar storage).
 *
 * Wire / transcript file-part `url` values are either:
 * - Legacy transcript `data:` URLs (base64 inline; new turns use pointers), or
 * - Opaque pointers that resolve to on-disk sidecars:
 *
 *   jeeves-attachment://chat/<threadId>/<attachmentId>
 *   jeeves-attachment://step/<cardId>/<stepKey>/<attachmentId>
 *
 * Disk layout (under the project store):
 *   chat → data/chat/<threadId>/attachments/<attachmentId>-<safeName>
 *   step → data/cards/<cardId>/chat-attachments/<stepKey>/<attachmentId>-<safeName>
 *
 * Card-library attachments (Info step) are a separate Phase 2 path and must
 * not reuse this scheme.
 */

export const ATTACHMENT_POINTER_SCHEME = "jeeves-attachment:";

export type ChatAttachmentPointer = {
  kind: "chat";
  threadId: string;
  attachmentId: string;
};

export type StepAttachmentPointer = {
  kind: "step";
  cardId: string;
  stepKey: string;
  attachmentId: string;
};

export type AttachmentPointer = ChatAttachmentPointer | StepAttachmentPointer;

/** High-confidence text extensions when MIME is empty or unhelpful. */
export const TEXT_ATTACHMENT_EXTENSIONS = [
  ".md",
  ".txt",
  ".csv",
  ".yaml",
  ".yml",
  ".toml",
  ".log",
] as const;

const TEXT_EXT_RE = /\.(md|txt|csv|ya?ml|toml|log)$/i;

/**
 * MIME / extension accept list for Cursor resource override (text only).
 * Intentionally excludes PDF and application/octet-stream.
 */
export const TEXT_ATTACHMENT_ACCEPT =
  "text/*,application/json,application/xml,.md,.txt,.csv,.yaml,.yml,.toml,.log";

/**
 * HTML `accept` for the card Info library picker: images + Phase 1 text
 * allowlist (no PDF / audio / octet-stream).
 */
export const CARD_LIBRARY_ATTACHMENT_ACCEPT = [
  "image/*",
  TEXT_ATTACHMENT_ACCEPT,
].join(",");

/** True when a file may be stored in the card attachment library. */
export function isCardLibraryAttachmentAllowed(
  mediaType: string,
  filename?: string,
): boolean {
  const mime = mediaType.trim().toLowerCase();
  if (mime.startsWith("image/")) return true;
  return isAllowlistedTextAttachment(mediaType, filename);
}

export function isDataUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("data:");
}

export function isAttachmentPointerUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(`${ATTACHMENT_POINTER_SCHEME}//`);
}

export function formatChatAttachmentPointer(
  threadId: string,
  attachmentId: string,
): string {
  return `${ATTACHMENT_POINTER_SCHEME}//chat/${encodeURIComponent(threadId)}/${encodeURIComponent(attachmentId)}`;
}

export function formatStepAttachmentPointer(
  cardId: string,
  stepKey: string,
  attachmentId: string,
): string {
  return `${ATTACHMENT_POINTER_SCHEME}//step/${encodeURIComponent(cardId)}/${encodeURIComponent(stepKey)}/${encodeURIComponent(attachmentId)}`;
}

/** Parse a pointer URL; returns null for data URLs and anything else. */
export function parseAttachmentPointer(url: string): AttachmentPointer | null {
  const trimmed = url.trim();
  const prefix = `${ATTACHMENT_POINTER_SCHEME}//`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  const parts = rest.split("/").filter(Boolean);
  if (parts[0] === "chat" && parts.length === 3) {
    const threadId = decodeURIComponent(parts[1]!);
    const attachmentId = decodeURIComponent(parts[2]!);
    if (!threadId || !attachmentId) return null;
    return { kind: "chat", threadId, attachmentId };
  }
  if (parts[0] === "step" && parts.length === 4) {
    const cardId = decodeURIComponent(parts[1]!);
    const stepKey = decodeURIComponent(parts[2]!);
    const attachmentId = decodeURIComponent(parts[3]!);
    if (!cardId || !stepKey || !attachmentId) return null;
    return { kind: "step", cardId, stepKey, attachmentId };
  }
  return null;
}

/**
 * Browser-fetchable URL for chips / image previews. Leaves `data:` alone;
 * returns null when the URL is not a known attachment reference.
 */
export function attachmentDisplayUrl(url: string): string | null {
  if (isDataUrl(url)) return url;
  const pointer = parseAttachmentPointer(url);
  if (!pointer) return null;
  if (pointer.kind === "chat") {
    return `/api/chat-threads/${encodeURIComponent(pointer.threadId)}/attachments/${encodeURIComponent(pointer.attachmentId)}`;
  }
  return `/api/cards/${encodeURIComponent(pointer.cardId)}/chat-attachments/${encodeURIComponent(pointer.stepKey)}/${encodeURIComponent(pointer.attachmentId)}`;
}

export function extensionOfFilename(filename: string | undefined): string {
  if (!filename) return "";
  const base = filename.trim().split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** True when MIME or filename extension is on the Phase 1 text allowlist. */
export function isAllowlistedTextAttachment(
  mediaType: string,
  filename?: string,
): boolean {
  const mime = mediaType.trim().toLowerCase();
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "text/xml"
  ) {
    return true;
  }
  // Empty / wrong MIME (incl. octet-stream): allow known text extensions only.
  return TEXT_EXT_RE.test(extensionOfFilename(filename));
}

/** Prefer UTF-8 `resource.text` over blob for allowlisted text types. */
export function isUtf8TextAttachment(
  mediaType: string,
  filename?: string,
): boolean {
  return isAllowlistedTextAttachment(mediaType, filename);
}

/** Guess a text MIME from filename when the browser left type empty. */
export function guessTextMediaType(filename: string | undefined): string | null {
  const ext = extensionOfFilename(filename);
  switch (ext) {
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    case ".toml":
      return "application/toml";
    case ".json":
      return "application/json";
    case ".xml":
      return "application/xml";
    default:
      return null;
  }
}
