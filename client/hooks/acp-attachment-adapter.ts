import type { AttachmentAdapter } from "@assistant-ui/core";
import { generateId } from "ai";
import { guessTextMediaType } from "@shared/attachment-refs";
import {
  attachmentAcceptFor,
  type PromptCapabilities,
} from "@shared/prompt-capabilities";

export type AttachmentUploadTarget =
  | { kind: "chat"; threadId: string }
  | { kind: "step"; cardId: string; stepKey: string };

export type UploadChatAttachment = (
  target: AttachmentUploadTarget,
  file: File,
) => Promise<{ mediaType: string; filename?: string; url: string }>;

function resolveContentType(file: File): string {
  return (
    file.type ||
    guessTextMediaType(file.name) ||
    "application/octet-stream"
  );
}

/**
 * Capability-gated attachment adapter for ACP composers.
 * Uploads bytes to a sidecar via REST, then puts a pointer URL on the file
 * part — never a base64 data URL (ADR 0017).
 */
export function createAcpAttachmentAdapter(
  caps: PromptCapabilities,
  opts: {
    target: AttachmentUploadTarget | null;
    upload: UploadChatAttachment;
  },
): AttachmentAdapter {
  const accept = attachmentAcceptFor(caps);
  return {
    accept,
    async add({ file }) {
      const contentType = resolveContentType(file);
      return {
        id: generateId(),
        type: contentType.startsWith("image/")
          ? "image"
          : contentType.startsWith("audio/")
            ? "file"
            : "document",
        name: file.name,
        file,
        contentType,
        content: [],
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment) {
      if (!opts.target) {
        throw new Error("Cannot upload attachment: chat session has no owner.");
      }
      const mimeType =
        attachment.contentType ||
        resolveContentType(attachment.file) ||
        "application/octet-stream";
      const uploaded = await opts.upload(opts.target, attachment.file);
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          {
            type: "file",
            mimeType: uploaded.mediaType || mimeType,
            filename: uploaded.filename ?? attachment.name,
            // Pointer URL (jeeves-attachment://…) — assistant-ui maps `data` → part.url
            data: uploaded.url,
          },
        ],
      };
    },
    async remove() {
      // noop — pending attachments are local until send uploads
    },
  };
}
