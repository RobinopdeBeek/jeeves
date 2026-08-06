/**
 * Browser-safe prompt attachment capabilities projected from ACP initialize
 * (ADR 0008: no ACP types on the client). Field names mirror the protocol's
 * promptCapabilities so the wire DTO stays stable; omitted / unknown agent
 * fields fail closed as unsupported.
 */

export type PromptCapabilities = {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
};

/** Wire DTO for a user-turn file (AI SDK file-part shape). */
export type ChatAttachment = {
  mediaType: string;
  filename?: string;
  /** data: URL carrying base64 payload. */
  url: string;
};

export type AttachmentKind = "image" | "audio" | "resource";

export const EMPTY_PROMPT_CAPABILITIES: PromptCapabilities = {
  image: false,
  audio: false,
  embeddedContext: false,
};

/**
 * Assumed before the ACP handshake reports real capabilities, so the composer
 * paperclip is usable while the agent is still starting. Images only — every
 * Cursor Agent session observed advertises `image`, and the rest stay fail-closed.
 * Superseded by negotiated capabilities the moment they arrive.
 */
export const OPTIMISTIC_PROMPT_CAPABILITIES: PromptCapabilities = {
  image: true,
  audio: false,
  embeddedContext: false,
};

/** True when nothing has been negotiated yet (all kinds still fail-closed). */
export function hasNoPromptCapabilities(caps: PromptCapabilities): boolean {
  return !caps.image && !caps.audio && !caps.embeddedContext;
}

/** Normalize an ACP initialize `agentCapabilities.promptCapabilities` object. */
export function normalizePromptCapabilities(
  raw: unknown,
): PromptCapabilities {
  if (raw == null || typeof raw !== "object") {
    return { ...EMPTY_PROMPT_CAPABILITIES };
  }
  const caps = raw as Record<string, unknown>;
  return {
    image: caps.image === true,
    audio: caps.audio === true,
    embeddedContext: caps.embeddedContext === true,
  };
}

export function classifyAttachmentKind(
  mediaType: string,
): AttachmentKind | "unsupported" {
  const mime = mediaType.trim().toLowerCase();
  if (!mime) return "unsupported";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  // Non-media files ride as embedded resources when the agent advertises it.
  return "resource";
}

/** HTML `accept` for the file picker; empty string means offer no attach control. */
export function attachmentAcceptFor(caps: PromptCapabilities): string {
  const parts: string[] = [];
  if (caps.image) parts.push("image/*");
  if (caps.audio) parts.push("audio/*");
  if (caps.embeddedContext) {
    // Broaden beyond media so documents can become embedded resources.
    parts.push(
      "text/*,application/json,application/pdf,application/xml,application/octet-stream",
    );
  }
  return parts.join(",");
}

export function isAttachmentKindAllowed(
  kind: AttachmentKind,
  caps: PromptCapabilities,
): boolean {
  switch (kind) {
    case "image":
      return caps.image;
    case "audio":
      return caps.audio;
    case "resource":
      return caps.embeddedContext;
  }
}

/** Human-readable reason when a media type is not offered. */
export function unsupportedAttachmentMessage(
  mediaType: string,
  caps: PromptCapabilities,
): string {
  const kind = classifyAttachmentKind(mediaType);
  if (kind === "unsupported") {
    return `Unsupported attachment type "${mediaType || "(missing)"}".`;
  }
  if (isAttachmentKindAllowed(kind, caps)) {
    return `Unsupported attachment type "${mediaType}".`;
  }
  const offered: string[] = [];
  if (caps.image) offered.push("images");
  if (caps.audio) offered.push("audio");
  if (caps.embeddedContext) offered.push("embedded files");
  if (offered.length === 0) {
    return `Attachments are not supported by this agent session (rejected "${mediaType}").`;
  }
  return `This agent session does not accept ${kind} attachments (rejected "${mediaType}"). Supported: ${offered.join(", ")}.`;
}

/**
 * Fail closed: every attachment must be allowed by negotiated capabilities.
 * Throws Error with a user-visible message.
 */
export function assertAttachmentsAllowed(
  attachments: readonly ChatAttachment[],
  caps: PromptCapabilities,
): void {
  for (const att of attachments) {
    const mediaType =
      typeof att.mediaType === "string" ? att.mediaType : "";
    const kind = classifyAttachmentKind(mediaType);
    if (
      kind === "unsupported" ||
      !isAttachmentKindAllowed(kind, caps)
    ) {
      throw new Error(unsupportedAttachmentMessage(mediaType, caps));
    }
    if (typeof att.url !== "string" || !att.url.startsWith("data:")) {
      throw new Error(
        `Attachment "${att.filename ?? mediaType}" must be a data URL.`,
      );
    }
    const dataMime = dataUrlMimeType(att.url);
    if (
      dataMime &&
      mediaType &&
      dataMime.toLowerCase() !== mediaType.trim().toLowerCase()
    ) {
      throw new Error(
        `Attachment "${att.filename ?? mediaType}" media type mismatch (declared ${mediaType}, data is ${dataMime}).`,
      );
    }
  }
}

/** MIME type from a `data:` URL, or null when the URL is not a data URL. */
export function dataUrlMimeType(url: string): string | null {
  const match = /^data:([^;,]+)(?:[;,])/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** Compact marker for transcript text / Grill extract when binary context is omitted. */
export function attachmentMarker(
  filename: string | undefined,
  mediaType: string,
): string {
  const name = filename?.trim() || "attachment";
  return `[attached: ${name} (${mediaType})]`;
}
