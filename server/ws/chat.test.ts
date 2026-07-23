import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { AcpBridge, type ChunkSubscriber } from "./chat.js";
import { MockAcpProcess, viWaitFor } from "./mock-acp-process.js";

function collectingSubscriber(): ChunkSubscriber & { chunks: UIMessageChunk[] } {
  const chunks: UIMessageChunk[] = [];
  return {
    chunks,
    onChunk(chunk) {
      chunks.push(chunk);
    },
  };
}

function textDeltas(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
}

function promptText(process: MockAcpProcess, index = 0): string {
  const prompt = process.prompts()[index]?.prompt as Array<{ text: string }>;
  return prompt[0]!.text;
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

    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Grill this feature: Pantry checker",
      history: [],
    });

    await viWaitFor(() => process.prompts().length === 1);

    const promptReq = process.promptRequest();

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

    await viWaitFor(() => sub.chunks.some((c) => c.type === "finish"));

    expect(process.prompts()[0].prompt).toEqual([
      { type: "text", text: "Grill this feature: Pantry checker" },
    ]);
    expect(textDeltas(sub.chunks)).toBe("What problem are you solving?");
    expect(sub.chunks.some((c) => c.type === "start")).toBe(true);
    expect(sub.chunks.some((c) => c.type === "finish")).toBe(true);

    expect(statuses[0]).toBe("ai-working");
    expect(statuses.at(-1)).toBe("needs-user");

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toHaveLength(1);
    expect(transcripts[0][0].role).toBe("assistant");
    expect(transcripts[0][0].parts).toEqual([
      { type: "text", text: "What problem are you solving?" },
    ]);
  });

  it("streams a user turn into assistant UIMessage parts and seeds prior transcript once", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-2");
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
    });

    const sub = collectingSubscriber();
    bridge.attach(sub);

    // Open with existing history so we skip the opener; seed waits for first send.
    await bridge.openSession({
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

    expect(process.prompts()).toHaveLength(0);

    const replyPromise = bridge.sendMessage("Pantry expiry alerts");
    await viWaitFor(() => process.prompts().length === 1);

    const promptReq = process.promptRequest();

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

    await replyPromise;
    expect(textDeltas(sub.chunks)).toBe("Who are the users?");
    expect(transcripts.at(-1)?.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(transcripts.at(-1)?.[1].parts).toEqual([
      { type: "text", text: "Pantry expiry alerts" },
    ]);
    expect(promptText(process, 0)).toContain("Prior transcript");
    expect(promptText(process, 0)).toContain("Pantry expiry alerts");
    expect(promptText(process, 0)).not.toContain("Prior grilling transcript");

    // Second user turn sends latest text only (already seeded).
    sub.chunks.length = 0;
    const secondPromise = bridge.sendMessage("Kitchen staff");
    await viWaitFor(() => process.prompts().length === 2);
    const prompt2 = process.written.filter(
      (m): m is { id: number; method: string } =>
        (m as { method?: string }).method === "session/prompt",
    )[1]!;
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Got it." },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: prompt2.id,
      result: { stopReason: "end_turn" },
    });
    await secondPromise;

    expect(promptText(process, 1)).toBe("Kitchen staff");
    expect(promptText(process, 1)).not.toContain("Prior transcript");
  });

  it("projects session/request_permission into a data-permission part and round-trips approve/deny", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-perm");

    const bridge = new AcpBridge({
      spawn: () => process,
    });

    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Grill this feature",
      history: [],
    });
    await viWaitFor(() => process.prompts().length === 1);

    const promptReq = process.promptRequest();

    // Agent asks for permission mid-turn (before the prompt RPC resolves).
    process.emit({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "sess-perm",
        toolCall: {
          toolCallId: "call_read_1",
          title: "Read file CONTEXT.md",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() => bridge.getPendingPermissionIds().includes("99"));

    bridge.respondToPermission("99", "allow-once");

    const rpcReply = process.written.find(
      (m): m is { id: number; result: unknown } =>
        (m as { id?: number; result?: unknown }).id === 99 &&
        (m as { result?: unknown }).result !== undefined,
    );
    expect(rpcReply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(bridge.getPendingPermissionIds()).toEqual([]);

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-perm",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I can read CONTEXT.md." },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    await viWaitFor(() => sub.chunks.some((c) => c.type === "finish"));

    const permChunks = sub.chunks.filter(
      (c) => typeof c.type === "string" && c.type === "data-permission",
    );
    expect(permChunks[0]).toMatchObject({
      type: "data-permission",
      id: "99",
      data: {
        requestId: "99",
        toolCallId: "call_read_1",
        title: "Read file CONTEXT.md",
        status: "pending",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    expect(
      permChunks.find((c) => (c as { data?: { status?: string } }).data?.status === "resolved"),
    ).toMatchObject({
      type: "data-permission",
      id: "99",
      data: {
        requestId: "99",
        status: "resolved",
        selectedOptionId: "allow-once",
      },
    });

    const assistant = bridge.getMessages().find((m) => m.role === "assistant");
    const part = assistant?.parts.find((p) => p.type === "data-permission") as {
      data: { status: string; selectedOptionId?: string };
    };
    expect(part.data.status).toBe("resolved");
    expect(part.data.selectedOptionId).toBe("allow-once");

    // Deny path on a follow-up turn.
    const replyPromise = bridge.sendMessage("Continue");
    await viWaitFor(() => process.prompts().length === 2);
    process.emit({
      jsonrpc: "2.0",
      id: 100,
      method: "session/request_permission",
      params: {
        sessionId: "sess-perm",
        toolCall: { toolCallId: "call_2", title: "Write file" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    await viWaitFor(() => bridge.getPendingPermissionIds().includes("100"));
    bridge.respondToPermission("100", "reject-once");
    const denyReply = process.written.find(
      (m): m is { id: number; result: unknown } =>
        (m as { id?: number }).id === 100 &&
        (m as { result?: unknown }).result !== undefined,
    );
    expect(denyReply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });

    const prompt2 = process.written.filter(
      (m): m is { id: number; method: string } =>
        (m as { method?: string }).method === "session/prompt",
    )[1]!;
    process.emit({
      jsonrpc: "2.0",
      id: prompt2.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;
  });

  it("replays buffered turn chunks on attach", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-buf");

    const bridge = new AcpBridge({
      spawn: () => process,
    });

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Open",
      history: [],
    });
    await viWaitFor(() => process.prompts().length === 1);

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-buf",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "buffered" },
        },
      },
    });

    const sub = collectingSubscriber();
    bridge.attach(sub);
    expect(textDeltas(sub.chunks)).toBe("buffered");

    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });
    await bridge.whenIdle();
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

    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Open the grill",
      history: [],
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();
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
    await bridge.whenIdle();

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
