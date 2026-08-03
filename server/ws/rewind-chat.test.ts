import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../cards/store.js";
import { ChatThreadStore } from "../chat-threads/store.js";
import { openDb } from "../db/index.js";
import { MockAcpProcess, viWaitFor } from "./mock-acp-process.js";
import { rewindProjectChat } from "./rewind-chat.js";
import { openChat } from "./open-chat.js";
import { createProjectChatSession } from "./chat-session.js";
import { ChatSessionRegistry } from "./session-registry.js";

function promptText(process: MockAcpProcess, index: number): string {
  const prompt = process.prompts()[index]?.prompt;
  if (!Array.isArray(prompt)) return "";
  const textBlock = prompt.find(
    (b): b is { type: "text"; text: string } =>
      !!b && typeof b === "object" && (b as { type?: string }).type === "text",
  );
  return textBlock?.text ?? "";
}

async function completeTurn(
  process: MockAcpProcess,
  handle: { sendMessage: (text: string) => Promise<void> },
  text: string,
  reply: string,
): Promise<void> {
  const turn = handle.sendMessage(text);
  await viWaitFor(() => process.prompts().length >= 1);
  const req = process.written.find(
    (m): m is { id: number; method: string } =>
      (m as { method?: string }).method === "session/prompt",
  )!;
  process.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply },
      },
    },
  });
  process.emit({
    jsonrpc: "2.0",
    id: req.id,
    result: { stopReason: "end_turn" },
  });
  await turn;
}

describe("rewindProjectChat", () => {
  it("truncates → kills warm ACP → respawns → reseeds without discarded branch context", async () => {
    const db = openDb(":memory:");
    const cards = new CardStore(db);
    const project = cards.ensureDefaultProject("jeeves", "/tmp/repo");
    const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-rewind-"));
    const threads = new ChatThreadStore(db, chatRoot);
    const thread = threads.createOrReuseEmptyDraft(project.id);

    const history: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Keep this" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Kept reply" }],
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "Discard this wrong turn" }],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "Wrong-direction answer" }],
      },
    ];
    threads.saveTranscript(thread.id, history);

    const registry = new ChatSessionRegistry();
    const first = new MockAcpProcess();
    first.autoHandshake("sess-before");
    const second = new MockAcpProcess();
    second.autoHandshake("sess-after");
    let spawnCount = 0;
    const spawn = () => {
      spawnCount += 1;
      return spawnCount === 1 ? first : second;
    };

    const session = createProjectChatSession(
      { threadId: thread.id },
      { threads, cwd: "/tmp/repo" },
    );

    // Warm with the full (pre-rewind) transcript and take a turn so context is seeded.
    const before = await openChat(session, { spawn, sessions: registry });
    expect(before.history.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    await completeTurn(first, before.handle, "follow-up", "ok");
    expect(promptText(first, 0)).toContain("Discard this wrong turn");
    expect(promptText(first, 0)).toContain("Wrong-direction answer");

    // Edit rewind: truncate to the first exchange, kill + respawn.
    const rewound = await rewindProjectChat(
      thread.id,
      { action: "truncate", headId: "a1" },
      { threads, spawn, sessions: registry, cwd: "/tmp/repo" },
    );

    expect(first.killed).toBe(true);
    expect(rewound.history.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(rewound.handle.reused).toBe(false);
    expect(spawnCount).toBe(2);
    expect(registry.hasWarm(session.id)).toBe(true);

    // Next agent turn reseeds from the truncated path only.
    const afterTurn = rewound.handle.sendMessage("Corrected direction");
    await viWaitFor(() => second.prompts().length === 1);
    const seed = promptText(second, 0);
    expect(seed).toContain("Prior transcript");
    expect(seed).toContain("Keep this");
    expect(seed).toContain("Kept reply");
    expect(seed).not.toContain("Discard this wrong turn");
    expect(seed).not.toContain("Wrong-direction answer");
    expect(seed).toContain("Corrected direction");

    const req = second.promptRequest();
    second.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "On track." },
        },
      },
    });
    second.emit({
      jsonrpc: "2.0",
      id: req.id,
      result: { stopReason: "end_turn" },
    });
    await afterTurn;

    // Sibling branch retained on disk for later switch (u2 under a1, plus new user turn).
    const siblings = threads.getBranches(thread.id, "u2");
    expect(siblings).toContain("u2");
    expect(siblings.length).toBeGreaterThanOrEqual(2);

    fs.rmSync(chatRoot, { recursive: true, force: true });
  });

  it("switch action kills warm ACP, respawns, and reseeds the sibling branch only", async () => {
    const db = openDb(":memory:");
    const cards = new CardStore(db);
    const project = cards.ensureDefaultProject("jeeves", "/tmp/repo");
    const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-switch-"));
    const threads = new ChatThreadStore(db, chatRoot);
    const thread = threads.createOrReuseEmptyDraft(project.id);

    threads.saveTranscript(thread.id, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Branch A prompt" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Branch A reply" }] },
    ]);
    threads.truncateTranscript(thread.id, null);
    threads.saveTranscript(thread.id, [
      { id: "u2", role: "user", parts: [{ type: "text", text: "Branch B prompt" }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "Branch B reply" }] },
    ]);

    const registry = new ChatSessionRegistry();
    const first = new MockAcpProcess();
    first.autoHandshake("sess-switch-1");
    const second = new MockAcpProcess();
    second.autoHandshake("sess-switch-2");
    let spawnCount = 0;
    const spawn = () => {
      spawnCount += 1;
      return spawnCount === 1 ? first : second;
    };

    const session = createProjectChatSession(
      { threadId: thread.id },
      { threads, cwd: "/tmp/repo" },
    );
    const before = await openChat(session, { spawn, sessions: registry });
    expect(before.history.map((m) => m.id)).toEqual(["u2", "a2"]);
    await completeTurn(first, before.handle, "still on B", "ok");
    expect(promptText(first, 0)).toContain("Branch B prompt");

    const result = await rewindProjectChat(
      thread.id,
      { action: "switch", branchId: "u1" },
      { threads, spawn, sessions: registry, cwd: "/tmp/repo" },
    );

    expect(first.killed).toBe(true);
    expect(result.history.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(result.branchable.headId).toBe("a1");
    expect(result.handle.reused).toBe(false);
    expect(spawnCount).toBe(2);

    const afterTurn = result.handle.sendMessage("Continue on A");
    await viWaitFor(() => second.prompts().length === 1);
    const seed = promptText(second, 0);
    expect(seed).toContain("Branch A prompt");
    expect(seed).toContain("Branch A reply");
    expect(seed).not.toContain("Branch B prompt");
    expect(seed).not.toContain("Branch B reply");
    expect(seed).toContain("Continue on A");

    const req = second.promptRequest();
    second.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "On A." },
        },
      },
    });
    second.emit({
      jsonrpc: "2.0",
      id: req.id,
      result: { stopReason: "end_turn" },
    });
    await afterTurn;

    fs.rmSync(chatRoot, { recursive: true, force: true });
  });
});
