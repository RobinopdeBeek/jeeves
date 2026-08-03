import { describe, expect, it } from "vitest";
import {
  assertAttachmentsAllowed,
  attachmentAcceptFor,
  attachmentMarker,
  classifyAttachmentKind,
  EMPTY_PROMPT_CAPABILITIES,
  normalizePromptCapabilities,
  unsupportedAttachmentMessage,
} from "./prompt-capabilities.js";

describe("normalizePromptCapabilities", () => {
  it("fails closed when initialize omits promptCapabilities", () => {
    expect(normalizePromptCapabilities(undefined)).toEqual(
      EMPTY_PROMPT_CAPABILITIES,
    );
    expect(normalizePromptCapabilities(null)).toEqual(
      EMPTY_PROMPT_CAPABILITIES,
    );
    expect(normalizePromptCapabilities({})).toEqual(EMPTY_PROMPT_CAPABILITIES);
  });

  it("treats only explicit true as enabled", () => {
    expect(
      normalizePromptCapabilities({
        image: true,
        audio: false,
        embeddedContext: "yes",
      }),
    ).toEqual({ image: true, audio: false, embeddedContext: false });
  });
});

describe("attachmentAcceptFor", () => {
  it("returns empty when nothing is enabled", () => {
    expect(attachmentAcceptFor(EMPTY_PROMPT_CAPABILITIES)).toBe("");
  });

  it("offers image/* when image capability is true", () => {
    expect(
      attachmentAcceptFor({ ...EMPTY_PROMPT_CAPABILITIES, image: true }),
    ).toBe("image/*");
  });

  it("joins enabled kinds", () => {
    const accept = attachmentAcceptFor({
      image: true,
      audio: true,
      embeddedContext: false,
    });
    expect(accept).toContain("image/*");
    expect(accept).toContain("audio/*");
  });
});

describe("classifyAttachmentKind", () => {
  it("maps media types to ACP-gated kinds", () => {
    expect(classifyAttachmentKind("image/png")).toBe("image");
    expect(classifyAttachmentKind("AUDIO/mpeg")).toBe("audio");
    expect(classifyAttachmentKind("application/pdf")).toBe("resource");
    expect(classifyAttachmentKind("")).toBe("unsupported");
  });
});

describe("assertAttachmentsAllowed", () => {
  const png: { mediaType: string; filename: string; url: string } = {
    mediaType: "image/png",
    filename: "a.png",
    url: "data:image/png;base64,aa==",
  };

  it("allows images when image capability is on", () => {
    expect(() =>
      assertAttachmentsAllowed([png], {
        ...EMPTY_PROMPT_CAPABILITIES,
        image: true,
      }),
    ).not.toThrow();
  });

  it("rejects images when capability is off with a clear message", () => {
    expect(() =>
      assertAttachmentsAllowed([png], EMPTY_PROMPT_CAPABILITIES),
    ).toThrow(/not supported|does not accept image/i);
  });

  it("rejects non-data URLs", () => {
    expect(() =>
      assertAttachmentsAllowed(
        [{ ...png, url: "https://example.com/a.png" }],
        { ...EMPTY_PROMPT_CAPABILITIES, image: true },
      ),
    ).toThrow(/data URL/i);
  });

  it("rejects mediaType that disagrees with the data URL MIME", () => {
    expect(() =>
      assertAttachmentsAllowed(
        [
          {
            mediaType: "image/png",
            filename: "a.pdf",
            url: "data:application/pdf;base64,aa==",
          },
        ],
        { ...EMPTY_PROMPT_CAPABILITIES, image: true },
      ),
    ).toThrow(/media type mismatch/i);
  });
});

describe("unsupportedAttachmentMessage / attachmentMarker", () => {
  it("lists supported kinds when rejecting", () => {
    expect(
      unsupportedAttachmentMessage("application/pdf", {
        image: true,
        audio: false,
        embeddedContext: false,
      }),
    ).toMatch(/Supported: images/);
  });

  it("formats a compact marker for text-only resume paths", () => {
    expect(attachmentMarker("shot.png", "image/png")).toBe(
      "[attached: shot.png (image/png)]",
    );
  });
});
