import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { AcpBridge, type AcpProcess } from "./chat.js";

/** In-memory ACP stdio stand-in — records client→agent RPC and can emit agent→client lines. */
class MockAcpProcess implements AcpProcess {
  readonly written: unknown[] = [];
  private readonly lineHandlers: Array<(line: string) => void> = [];
  private closed = false;

  write(line: string): void {
    if (this.closed) throw new Error("process closed");
    this.written.push(JSON.parse(line));
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  kill(): void {
    this.closed = true;
  }

  /** Simulate one newline-delimited JSON-RPC message from agent stdout. */
  emit(message: unknown): void {
    const line = JSON.stringify(message);
    for (const handler of this.lineHandlers) handler(line);
  }

  /** Auto-answer initialize / authenticate / session/new with fixed sessionId. */
  autoHandshake(sessionId = "sess-test"): void {
    const answered = new Set<number>();
    const originalWrite = this.write.bind(this);
    this.write = (line: string) => {
      originalWrite(line);
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (m.id == null || m.method == null || answered.has(m.id)) return;
      let result: unknown;
      if (m.method === "initialize") result = { protocolVersion: 1 };
      else if (m.method === "authenticate") result = {};
      else if (m.method === "session/new") result = { sessionId };
      else return;
      answered.add(m.id);
      queueMicrotask(() => {
        this.emit({ jsonrpc: "2.0", id: m.id, result });
      });
    };
  }

  prompts(): Array<{ sessionId: string; prompt: unknown }> {
    return this.written
      .filter((m): m is { method: string; params: { sessionId: string; prompt: unknown } } => {
        const msg = m as { method?: string };
        return msg.method === "session/prompt";
      })
      .map((m) => m.params);
  }
}

async function collectChunks(
  stream: AsyncIterable<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function textDeltas(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
}

describe("AcpBridge", () => {
  it("opens a session on empty history and projects agent_message_chunk into UIMessage parts", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-1");

    const statuses: Array<"ai-working" | "needs-user"> = [];
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onStatus: (status) => statuses.push(status),
      onTranscript: (messages) => transcripts.push(messages),
    });

    const streamPromise = bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Grill this feature: Pantry checker",
      history: [],
    });

    // Wait until the opening prompt is sent, then stream agent chunks + finish the RPC.
    await viWaitFor(() => process.prompts().length === 1);

    const promptReq = process.written.find(
      (m): m is { id: number; method: string } =>
        (m as { method?: string }).method === "session/prompt",
    )!;

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "What problem " },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "are you solving?" },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    const chunks = await collectChunks(await streamPromise);

    expect(process.prompts()[0].prompt).toEqual([
      { type: "text", text: "Grill this feature: Pantry checker" },
    ]);
    expect(textDeltas(chunks)).toBe("What problem are you solving?");
    expect(chunks.some((c) => c.type === "start")).toBe(true);
    expect(chunks.some((c) => c.type === "finish")).toBe(true);

    expect(statuses[0]).toBe("ai-working");
    expect(statuses.at(-1)).toBe("needs-user");

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toHaveLength(1);
    expect(transcripts[0][0].role).toBe("assistant");
    expect(transcripts[0][0].parts).toEqual([
      { type: "text", text: "What problem are you solving?" },
    ]);
  });

  it("streams a user turn into assistant UIMessage parts and appends both to the transcript", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-2");
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
    });

    // Open with existing history so we skip the opener.
    const openStream = await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "should not be sent",
      history: [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "What problem are you solving?" }],
        },
      ],
    });
    for await (const _ of openStream) {
      /* drain empty resume stream */
    }

    expect(process.prompts()).toHaveLength(0);

    const replyPromise = bridge.sendMessage("Pantry expiry alerts");
    await viWaitFor(() => process.prompts().length === 1);

    const promptReq = process.written.find(
      (m): m is { id: number; method: string } =>
        (m as { method?: string }).method === "session/prompt",
    )!;

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Who are the users?" },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    const chunks = await collectChunks(await replyPromise);
    expect(textDeltas(chunks)).toBe("Who are the users?");
    expect(transcripts.at(-1)?.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(transcripts.at(-1)?.[1].parts).toEqual([
      { type: "text", text: "Pantry expiry alerts" },
    ]);
    expect(process.prompts()[0].prompt).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Prior grilling transcript"),
      },
    ]);
    expect(
      (process.prompts()[0].prompt as Array<{ text: string }>)[0].text,
    ).toContain("Pantry expiry alerts");
  });

  it("persists transcript and flips grill status through bridge callbacks", async () => {
    const { openDb } = await import("../db/index.js");
    const { CardStore } = await import("../cards/store.js");
    const { ArtifactStore } = await import("../artifacts/store.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const db = openDb(":memory:");
    const store = new CardStore(db);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-acp-"));
    const artifacts = new ArtifactStore(db, artifactRoot);
    const projectId = store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    const cardId = store.createCard(projectId).id;
    store.updateCard(cardId, { title: "Pantry" });
    store.decideKind(cardId, "feature");

    const process = new MockAcpProcess();
    process.autoHandshake("sess-persist");

    const bridge = new AcpBridge({
      spawn: () => process,
      onStatus: (status) => {
        store.setStepStatus(cardId, "grill", status);
      },
      onTranscript: (messages) => {
        artifacts.upsertTranscript(cardId, "grill", 0, messages);
      },
    });

    const streamPromise = bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Open the grill",
      history: [],
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.written.find(
      (m): m is { id: number; method: string } =>
        (m as { method?: string }).method === "session/prompt",
    )!;
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-persist",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "First question?" },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await collectChunks(await streamPromise);

    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );
    const latest = artifacts.latest(cardId, { stepKey: "grill", round: 0, kind: "transcript" });
    expect(latest).toBeDefined();
    const saved = JSON.parse(artifacts.readContent(latest!)) as UIMessage[];
    expect(saved).toHaveLength(1);
    expect(saved[0].parts).toEqual([{ type: "text", text: "First question?" }]);

    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });
});

/** Tiny poll helper — avoids pulling async utilities for one wait. */
async function viWaitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("viWaitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
