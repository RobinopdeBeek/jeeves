import type { AttachmentAdapter } from "@assistant-ui/core";
import { generateId } from "ai";
import {
  attachmentAcceptFor,
  type PromptCapabilities,
} from "@shared/prompt-capabilities";

async function fileToDataUrl(file: File): Promise<string> {
  if (typeof FileReader === "undefined") {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const b64 =
      typeof btoa === "function"
        ? btoa(binary)
        : Buffer.from(bytes).toString("base64");
    return `data:${file.type || "application/octet-stream"};base64,${b64}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

/**
 * Capability-gated attachment adapter for ACP composers.
 * `accept` is empty when the session advertises no prompt attachment kinds.
 */
export function createAcpAttachmentAdapter(
  caps: PromptCapabilities,
): AttachmentAdapter {
  const accept = attachmentAcceptFor(caps);
  return {
    accept,
    async add({ file }) {
      return {
        id: generateId(),
        type: file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("audio/")
            ? "file"
            : "document",
        name: file.name,
        file,
        contentType: file.type,
        content: [],
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment) {
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          {
            type: "file",
            mimeType: attachment.contentType ?? "application/octet-stream",
            filename: attachment.name,
            data: await fileToDataUrl(attachment.file),
          },
        ],
      };
    },
    async remove() {
      // noop — local-only pending attachments
    },
  };
}
