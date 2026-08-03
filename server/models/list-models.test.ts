import { describe, expect, it } from "vitest";
import { parseAgentModelsOutput } from "./list-models.js";

describe("parseAgentModelsOutput", () => {
  it("parses agent models / --list-models text lines", () => {
    const stdout = [
      "Available models",
      "",
      "gpt-5.5-extra-high-fast - GPT-5.5 Extra High Fast (current)",
      "composer-2-fast - Composer 2 Fast (default)",
      "claude-opus-4-8 - Claude Opus 4.8",
      "",
    ].join("\n");

    expect(parseAgentModelsOutput(stdout)).toEqual([
      {
        id: "gpt-5.5-extra-high-fast",
        displayName: "GPT-5.5 Extra High Fast",
        current: true,
        default: false,
      },
      {
        id: "composer-2-fast",
        displayName: "Composer 2 Fast",
        current: false,
        default: true,
      },
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        current: false,
        default: false,
      },
    ]);
  });

  it("strips ANSI color codes from CLI output", () => {
    const stdout =
      "\u001b[36mcomposer-2.5\u001b[39m \u001b[2m- Composer 2.5\u001b[22m\n";
    expect(parseAgentModelsOutput(stdout)).toEqual([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        current: false,
        default: false,
      },
    ]);
  });

  it("returns empty when the account has no models", () => {
    expect(parseAgentModelsOutput("No models available for this account.")).toEqual(
      [],
    );
  });
});
