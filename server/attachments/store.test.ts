import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatChatAttachmentPointer,
  formatStepAttachmentPointer,
  isDataUrl,
  parseAttachmentPointer,
} from "../../shared/attachment-refs.js";
import {
  absolutePathForPointer,
  chatAttachmentsDir,
  materializeAttachment,
  materializeAttachments,
  resolveAttachmentBytes,
  safeAttachmentFilename,
  stepAttachmentsDir,
  writeAttachmentBytes,
} from "./store.js";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOTES_MD = `data:text/markdown;base64,${Buffer.from("# hi\n", "utf8").toString("base64")}`;

describe("safeAttachmentFilename", () => {
  it("strips path segments and unsafe characters", () => {
    expect(safeAttachmentFilename("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentFilename("my notes!.md")).toBe("my notes_.md");
  });
});

describe("materialize + resolve attachments", () => {
  let chatRoot: string;
  let artifactRoot: string;

  beforeEach(() => {
    chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-att-chat-"));
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-att-art-"));
  });

  afterEach(() => {
    fs.rmSync(chatRoot, { recursive: true, force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("writes chat sidecars and rewrites data URLs to pointers", () => {
    const out = materializeAttachment(
      { kind: "chat", chatRoot, threadId: "tid1" },
      { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
    );
    expect(out.url).toMatch(/^jeeves-attachment:\/\/chat\/tid1\//);
    expect(out.mediaType).toBe("image/png");
    const pointer = parseAttachmentPointer(out.url)!;
    expect(pointer.kind).toBe("chat");
    const abs = absolutePathForPointer(pointer, { chatRoot, artifactRoot });
    expect(abs.startsWith(path.join(chatRoot, "tid1", "attachments"))).toBe(
      true,
    );
    expect(fs.existsSync(abs)).toBe(true);

    const resolved = resolveAttachmentBytes(out, { chatRoot, artifactRoot });
    expect(resolved.mimeType).toBe("image/png");
    expect(resolved.bytes.length).toBeGreaterThan(0);
  });

  it("writes step sidecars under cards/<cardId>/chat-attachments/<stepKey>/", () => {
    const out = materializeAttachment(
      {
        kind: "step",
        artifactRoot,
        cardId: "card1",
        stepKey: "grill",
      },
      { mediaType: "text/markdown", filename: "notes.md", url: NOTES_MD },
    );
    expect(out.url).toBe(
      formatStepAttachmentPointer(
        "card1",
        "grill",
        parseAttachmentPointer(out.url)!.attachmentId,
      ),
    );
    const dir = stepAttachmentsDir(artifactRoot, "card1", "grill");
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir).some((n) => n.endsWith("-notes.md"))).toBe(true);

    const text = resolveAttachmentBytes(out, { chatRoot, artifactRoot })
      .bytes.toString("utf8");
    expect(text).toBe("# hi\n");
  });

  it("leaves existing pointers untouched", () => {
    const pointer = formatChatAttachmentPointer("tid", "aid");
    const att = {
      mediaType: "image/png",
      filename: "x.png",
      url: pointer,
    };
    expect(
      materializeAttachments({ kind: "chat", chatRoot, threadId: "tid" }, [
        att,
      ]),
    ).toEqual([att]);
  });

  it("writeAttachmentBytes stores sidecars without a data URL", () => {
    const out = writeAttachmentBytes(
      { kind: "chat", chatRoot, threadId: "tid-upload" },
      {
        filename: "hello.md",
        mediaType: "text/markdown",
        bytes: Buffer.from("# hi\n", "utf8"),
      },
    );
    expect(out.url.startsWith("jeeves-attachment://chat/tid-upload/")).toBe(
      true,
    );
    expect(isDataUrl(out.url)).toBe(false);
    const dir = chatAttachmentsDir(chatRoot, "tid-upload");
    expect(fs.readdirSync(dir).some((n) => n.endsWith("-hello.md"))).toBe(true);
  });

  it("rejects path escape via crafted ids", () => {
    expect(() =>
      materializeAttachment(
        { kind: "chat", chatRoot, threadId: "../escape" },
        { mediaType: "text/plain", filename: "a.txt", url: NOTES_MD },
      ),
    ).toThrow(/invalid thread id/i);
  });
});
