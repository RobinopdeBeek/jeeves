import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  buildPromptContentBlocks,
  buildSeedPromptContentBlocks,
  parseDataUrl,
  userMessageParts,
} from "./acp-content.js";
import { EMPTY_PROMPT_CAPABILITIES } from "../../shared/prompt-capabilities.js";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("parseDataUrl", () => {
  it("strips the data: prefix and keeps mime + raw base64", () => {
    expect(parseDataUrl(TINY_PNG)).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    });
  });
});

describe("buildPromptContentBlocks", () => {
  const imageCaps = { ...EMPTY_PROMPT_CAPABILITIES, image: true };

  it("sends text + image ContentBlocks when image is enabled", () => {
    expect(
      buildPromptContentBlocks({
        text: "What is in this?",
        attachments: [
          { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
        ],
        caps: imageCaps,
      }),
    ).toEqual([
      { type: "text", text: "What is in this?" },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    ]);
  });

  it("allows attachment-only turns", () => {
    const blocks = buildPromptContentBlocks({
      text: "",
      attachments: [
        { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
      ],
      caps: imageCaps,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("rejects unsupported kinds before building blocks", () => {
    expect(() =>
      buildPromptContentBlocks({
        text: "hi",
        attachments: [
          { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
        ],
        caps: EMPTY_PROMPT_CAPABILITIES,
      }),
    ).toThrow(/not supported|does not accept image/i);
  });
});

describe("buildSeedPromptContentBlocks", () => {
  const imageCaps = { ...EMPTY_PROMPT_CAPABILITIES, image: true };

  it("re-emits prior image blocks and keeps markers in the text preamble", () => {
    const history: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "Look" },
          {
            type: "file",
            url: TINY_PNG,
            mediaType: "image/png",
            filename: "dot.png",
          },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "A red pixel." }],
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "And now?" }],
      },
    ];

    const blocks = buildSeedPromptContentBlocks({
      history,
      latestText: "And now?",
      caps: imageCaps,
    });

    expect(blocks[0]).toMatchObject({ type: "text" });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("[attached: dot.png (image/png)]");
    expect(text).toContain("User: And now?");
    expect(blocks.some((b) => b.type === "image")).toBe(true);
  });
});

describe("userMessageParts", () => {
  it("stores text and AI SDK file parts for the visible transcript", () => {
    expect(
      userMessageParts("hi", [
        { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
      ]),
    ).toEqual([
      { type: "text", text: "hi" },
      {
        type: "file",
        url: TINY_PNG,
        mediaType: "image/png",
        filename: "dot.png",
      },
    ]);
  });
});
