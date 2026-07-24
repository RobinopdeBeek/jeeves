import fs from "node:fs";
import path from "node:path";
import type { UIMessage } from "ai";

/** Flatten a chat transcript into role-tagged text for the grill-session extract. */
export function serializeTranscriptForExtract(messages: UIMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    const lines: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text") {
        const text = part.text.trim();
        if (text) lines.push(text);
        continue;
      }
      if (part.type === "data-permission") {
        lines.push("[permission request omitted]");
      }
    }
    if (lines.length === 0) continue;
    blocks.push(`${role}:\n${lines.join("\n\n")}`);
  }
  return blocks.join("\n\n---\n\n");
}

/** Load grill-session.md and inject the serialized transcript. */
export function buildGrillSessionPrompt(
  transcriptText: string,
  promptsRoot: string,
): string {
  const templatePath = path.join(promptsRoot, "chat", "grill-session.md");
  const template = fs.readFileSync(templatePath, "utf8");
  return template.replaceAll("{{transcript}}", transcriptText || "(empty)");
}

/**
 * Trim model output, strip accidental YAML frontmatter, and reject empty /
 * non-Q&A bodies. Returns null when the extract is unusable.
 */
export function normalizeGrillSessionBody(raw: string): string | null {
  let body = raw.trim();
  if (!body) return null;

  if (body.startsWith("---")) {
    const end = body.indexOf("\n---\n", 3);
    if (end !== -1) {
      body = body.slice(end + "\n---\n".length).trim();
    }
  }
  if (!body) return null;

  // Require a heading or an explicit Q marker so we don't accept process chatter.
  if (!/^#{1,6}\s/m.test(body) && !/\bQ\d*\b/i.test(body)) {
    return null;
  }

  return body;
}
