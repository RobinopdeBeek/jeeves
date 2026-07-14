import { describe, expect, it } from "vitest";
import { appendLogLine, formatRunLogText } from "./run-log";

const TOKENIZED = `Checking
 for
 \`.jeeves\`
 and creating \`.
jeeves/plan
.md\` per
 the instructions
.

→ glob (running)
→ shell (completed)
<p
romise>COMPLETE
</promise>`;

describe("formatRunLogText", () => {
  it("merges tokenized assistant fragments into readable lines", () => {
    const formatted = formatRunLogText(TOKENIZED);
    expect(formatted).toContain(
      "Checking for `.jeeves` and creating `.jeeves/plan.md` per the instructions.",
    );
    expect(formatted).toContain("→ glob (running)");
    expect(formatted).toContain("→ shell (completed)");
    expect(formatted).toContain("<promise>COMPLETE</promise>");
  });
});

describe("appendLogLine", () => {
  it("concatenates assistant chunks without extra breaks", () => {
    let text = "";
    text = appendLogLine(text, "Checking");
    text = appendLogLine(text, " for");
    expect(text).toBe("Checking for");
  });

  it("puts tool lines on their own row", () => {
    const text = appendLogLine("Done.", "→ glob (running)");
    expect(text).toBe("Done.\n→ glob (running)\n");
  });
});
