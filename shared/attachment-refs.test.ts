import { describe, expect, it } from "vitest";
import {
  attachmentDisplayUrl,
  CARD_LIBRARY_ATTACHMENT_ACCEPT,
  formatChatAttachmentPointer,
  formatStepAttachmentPointer,
  isAllowlistedTextAttachment,
  isAttachmentPointerUrl,
  isCardLibraryAttachmentAllowed,
  isDataUrl,
  parseAttachmentPointer,
  TEXT_ATTACHMENT_ACCEPT,
} from "./attachment-refs.js";

describe("attachment pointer scheme", () => {
  it("formats and parses chat pointers", () => {
    const url = formatChatAttachmentPointer("tid1", "aid1");
    expect(url).toBe("jeeves-attachment://chat/tid1/aid1");
    expect(isAttachmentPointerUrl(url)).toBe(true);
    expect(parseAttachmentPointer(url)).toEqual({
      kind: "chat",
      threadId: "tid1",
      attachmentId: "aid1",
    });
  });

  it("formats and parses step pointers", () => {
    const url = formatStepAttachmentPointer("card1", "grill", "aid2");
    expect(url).toBe("jeeves-attachment://step/card1/grill/aid2");
    expect(parseAttachmentPointer(url)).toEqual({
      kind: "step",
      cardId: "card1",
      stepKey: "grill",
      attachmentId: "aid2",
    });
  });

  it("rejects data URLs and malformed pointers", () => {
    expect(parseAttachmentPointer("data:text/plain;base64,YQ==")).toBeNull();
    expect(parseAttachmentPointer("jeeves-attachment://chat/only-one")).toBeNull();
    expect(isDataUrl("data:text/plain;base64,YQ==")).toBe(true);
  });

  it("maps pointers to serve URLs for UI reload", () => {
    expect(
      attachmentDisplayUrl(formatChatAttachmentPointer("t1", "a1")),
    ).toBe("/api/chat-threads/t1/attachments/a1");
    expect(
      attachmentDisplayUrl(formatStepAttachmentPointer("c1", "spec", "a2")),
    ).toBe("/api/cards/c1/chat-attachments/spec/a2");
    expect(attachmentDisplayUrl("data:image/png;base64,aa==")).toBe(
      "data:image/png;base64,aa==",
    );
  });
});

describe("text attachment allowlist", () => {
  it("accepts text/*, json, xml by MIME", () => {
    expect(isAllowlistedTextAttachment("text/markdown")).toBe(true);
    expect(isAllowlistedTextAttachment("text/plain")).toBe(true);
    expect(isAllowlistedTextAttachment("application/json")).toBe(true);
    expect(isAllowlistedTextAttachment("application/xml")).toBe(true);
  });

  it("falls back to extension when MIME is empty or octet-stream", () => {
    expect(isAllowlistedTextAttachment("", "notes.md")).toBe(true);
    expect(
      isAllowlistedTextAttachment("application/octet-stream", "data.yaml"),
    ).toBe(true);
    expect(isAllowlistedTextAttachment("", "photo.png")).toBe(false);
  });

  it("does not broadly allow PDF or bare octet-stream", () => {
    expect(isAllowlistedTextAttachment("application/pdf")).toBe(false);
    expect(isAllowlistedTextAttachment("application/octet-stream")).toBe(false);
    expect(TEXT_ATTACHMENT_ACCEPT).not.toContain("application/pdf");
    expect(TEXT_ATTACHMENT_ACCEPT).not.toContain("octet-stream");
  });
});

describe("card library attachment allowlist", () => {
  it("allows images and text allowlist types", () => {
    expect(isCardLibraryAttachmentAllowed("image/png", "a.png")).toBe(true);
    expect(isCardLibraryAttachmentAllowed("text/markdown", "a.md")).toBe(true);
    expect(isCardLibraryAttachmentAllowed("", "notes.yaml")).toBe(true);
  });

  it("rejects PDF and other unsupported types", () => {
    expect(isCardLibraryAttachmentAllowed("application/pdf", "a.pdf")).toBe(
      false,
    );
    expect(
      isCardLibraryAttachmentAllowed(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "a.docx",
      ),
    ).toBe(false);
    expect(CARD_LIBRARY_ATTACHMENT_ACCEPT).toContain("image/*");
    expect(CARD_LIBRARY_ATTACHMENT_ACCEPT).toContain("text/*");
    expect(CARD_LIBRARY_ATTACHMENT_ACCEPT).not.toContain("application/pdf");
  });
});
