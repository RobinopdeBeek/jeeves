/**
 * ACP ContentBlock conversion — server-only (ADR 0008: no ACP types on the client).
 */
import type { UIMessage } from "ai";
import {
  assertAttachmentsAllowed,
  attachmentMarker,
  classifyAttachmentKind,
  type ChatAttachment,
  type PromptCapabilities,
} from "../../shared/prompt-capabilities.js";

export type AcpTextBlock = { type: "text"; text: string };
export type AcpImageBlock = {
  type: "image";
  mimeType: string;
  data: string;
};
export type AcpAudioBlock = {
  type: "audio";
  mimeType: string;
  data: string;
};
export type AcpResourceBlock = {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
};
export type AcpContentBlock =
  | AcpTextBlock
  | AcpImageBlock
  | AcpAudioBlock
  | AcpResourceBlock;

const DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]+)$/i;

export function parseDataUrl(url: string): { mimeType: string; data: string } {
  const match = DATA_URL_RE.exec(url.trim());
  if (!match) {
    throw new Error("Attachment must be a base64 data URL.");
  }
  return { mimeType: match[1]!.toLowerCase(), data: match[2]! };
}

function attachmentToBlock(
  att: ChatAttachment,
  caps: PromptCapabilities,
): AcpContentBlock {
  const mediaType = att.mediaType.trim().toLowerCase();
  const kind = classifyAttachmentKind(mediaType);
  const { mimeType, data } = parseDataUrl(att.url);
  const resolvedMime = mediaType || mimeType;

  if (kind === "image" && caps.image) {
    return { type: "image", mimeType: resolvedMime, data };
  }
  if (kind === "audio" && caps.audio) {
    return { type: "audio", mimeType: resolvedMime, data };
  }
  if (kind === "resource" && caps.embeddedContext) {
    const name = att.filename?.trim() || "attachment";
    const uri = `attachment://${encodeURIComponent(name)}`;
    if (resolvedMime.startsWith("text/") || resolvedMime === "application/json") {
      const text = Buffer.from(data, "base64").toString("utf8");
      return {
        type: "resource",
        resource: { uri, mimeType: resolvedMime, text },
      };
    }
    return {
      type: "resource",
      resource: { uri, mimeType: resolvedMime, blob: data },
    };
  }
  throw new Error(
    `Cannot convert attachment "${att.filename ?? mediaType}" to an ACP ContentBlock.`,
  );
}

function filePartsAsAttachments(message: UIMessage): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const part of message.parts) {
    if (part.type !== "file") continue;
    const file = part as {
      type: "file";
      mediaType: string;
      filename?: string;
      url: string;
    };
    out.push({
      mediaType: file.mediaType,
      filename: file.filename,
      url: file.url,
    });
  }
  return out;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function describeMessageLine(message: UIMessage): string {
  const text = messageText(message).trim();
  const markers = filePartsAsAttachments(message).map((a) =>
    attachmentMarker(a.filename, a.mediaType),
  );
  const body = [text, ...markers].filter(Boolean).join("\n");
  return `${message.role === "user" ? "User" : "Assistant"}: ${body}`;
}

/**
 * Build the ACP prompt array for a user turn.
 * Validates attachments against capabilities (fail closed) before conversion.
 */
export function buildPromptContentBlocks(opts: {
  text: string;
  attachments?: readonly ChatAttachment[];
  caps: PromptCapabilities;
}): AcpContentBlock[] {
  const attachments = opts.attachments ?? [];
  assertAttachmentsAllowed(attachments, opts.caps);

  const blocks: AcpContentBlock[] = [];
  if (opts.text.length > 0) {
    blocks.push({ type: "text", text: opts.text });
  }
  for (const att of attachments) {
    blocks.push(attachmentToBlock(att, opts.caps));
  }
  if (blocks.length === 0) {
    throw new Error("Message must include text or at least one attachment.");
  }
  return blocks;
}

/**
 * Seed-once cold resume: history as text (with attachment markers) plus
 * re-emitted prior image/audio/resource blocks the agent still accepts, then
 * the latest turn blocks.
 */
export function buildSeedPromptContentBlocks(opts: {
  history: UIMessage[];
  /** History includes the just-appended user turn as its last message. */
  latestText: string;
  latestAttachments?: readonly ChatAttachment[];
  caps: PromptCapabilities;
}): AcpContentBlock[] {
  const prior = opts.history.slice(0, -1);
  const latestBlocks = buildPromptContentBlocks({
    text: opts.latestText,
    attachments: opts.latestAttachments,
    caps: opts.caps,
  });

  if (prior.length === 0) return latestBlocks;

  const lines = prior.map(describeMessageLine);
  const preamble = [
    "Prior transcript (continue from here; do not repeat answered questions):",
    ...lines,
    "",
    "User:",
  ].join("\n");

  // Fold the latest text into the preamble when present so role labels stay clear;
  // attachment ContentBlocks follow as structured blocks.
  const latestTextBlock = latestBlocks.find((b) => b.type === "text");
  const latestNonText = latestBlocks.filter((b) => b.type !== "text");
  const textBody =
    latestTextBlock && latestTextBlock.type === "text"
      ? `${preamble} ${latestTextBlock.text}`
      : `${preamble} (see attachments)`;

  const priorAttachmentBlocks: AcpContentBlock[] = [];
  for (const message of prior) {
    if (message.role !== "user") continue;
    const atts = filePartsAsAttachments(message);
    for (const att of atts) {
      try {
        assertAttachmentsAllowed([att], opts.caps);
        priorAttachmentBlocks.push(attachmentToBlock(att, opts.caps));
      } catch {
        // Drop prior attachments the current agent no longer accepts; markers remain in text.
      }
    }
  }

  return [
    { type: "text", text: textBody },
    ...priorAttachmentBlocks,
    ...latestNonText,
  ];
}

/** AI SDK user-message parts for the visible transcript. */
export function userMessageParts(
  text: string,
  attachments: readonly ChatAttachment[],
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  if (text.length > 0) {
    parts.push({ type: "text", text });
  }
  for (const att of attachments) {
    parts.push({
      type: "file",
      url: att.url,
      mediaType: att.mediaType,
      ...(att.filename != null ? { filename: att.filename } : {}),
    });
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "" });
  }
  return parts;
}
