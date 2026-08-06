import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { frameSpecAssistUserMessage } from "../../shared/spec-assist-frame.js";
import { frameTasksAssistUserMessage } from "../../shared/tasks-assist-frame.js";
import {
  AcpBridge,
  decideHeadlessPermission,
  decideInteractivePermission,
  type ChunkSubscriber,
} from "./chat.js";
import {
  MOCK_MODEL_OPTION,
  MockAcpProcess,
  viWaitFor,
} from "./mock-acp-process.js";

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
  it("starts a new text part after a tool_call gap so segments are not glued together", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-gap");

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: () => {},
    });
    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Grill this",
      history: [],
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-gap",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "I'll read the project context first.",
          },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-gap",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "Read CONTEXT.md",
          status: "pending",
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-gap",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Test 2 has no description.",
          },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    await viWaitFor(() => sub.chunks.some((c) => c.type === "finish"));

    const textStarts = sub.chunks.filter((c) => c.type === "text-start");
    expect(textStarts.length).toBe(2);
    expect(textDeltas(sub.chunks)).toBe(
      "I'll read the project context first.Test 2 has no description.",
    );

    const assistant = bridge.getMessages()[0]!;
    const textParts = assistant.parts.filter((p) => p.type === "text");
    expect(textParts).toEqual([
      { type: "text", text: "I'll read the project context first." },
      { type: "text", text: "Test 2 has no description." },
    ]);
  });

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

  it("warms ACP without an auto turn when openingPrompt is null and history is empty", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-null-opener");
    const statuses: Array<"ai-working" | "needs-user"> = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onStatus: (status) => statuses.push(status),
      onTranscript: () => {},
    });

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(process.prompts()).toHaveLength(0);
    expect(statuses).toEqual([]);
    expect(process.killed).toBe(false);
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

  it("persists the client messageId on the user turn (branch picker lookup)", async () => {
    // Branch pickers key off the UI message id. If the server mints a different
    // id, getBranches(uiId) is empty until a remount loads server ids.
    const process = new MockAcpProcess();
    process.autoHandshake("sess-msgid");
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
    });

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    const replyPromise = bridge.sendMessage("Edited prompt", {
      messageId: "client-user-42",
    });
    await viWaitFor(() => process.prompts().length === 1);

    expect(transcripts.at(-1)?.[0]?.id).toBe("client-user-42");
    expect(bridge.getMessages()[0]?.id).toBe("client-user-42");

    const promptReq = process.promptRequest();
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;
  });

  it("persists the user turn before the prompt RPC finishes (mid-stream reattach)", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-mid");
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
    });

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    const replyPromise = bridge.sendMessage("Still thinking about pantry alerts");
    await viWaitFor(() => process.prompts().length === 1);

    // Disk/in-memory ready must already include the user message while AI works.
    expect(bridge.isAiWorking()).toBe(true);
    expect(bridge.getMessages().map((m) => m.role)).toEqual(["user"]);
    expect(transcripts.at(-1)?.map((m) => m.role)).toEqual(["user"]);
    expect(transcripts.at(-1)?.[0]?.parts).toEqual([
      { type: "text", text: "Still thinking about pantry alerts" },
    ]);

    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;
    expect(transcripts.at(-1)?.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps Spec markdown out of the transcript while framing the agent prompt", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-spec");
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
      frameUserMessage: frameSpecAssistUserMessage,
    });
    bridge.attach(collectingSubscriber());

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "unused",
      history: [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "How can I help with the Spec?" }],
        },
      ],
    });

    const replyPromise = bridge.sendMessage("Tighten acceptance criteria", {
      liveDraftBody: "# Spec\n\nDraft body\n",
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-spec",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Updated." },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;

    const userTurn = transcripts.at(-1)?.find((m) => m.role === "user");
    expect(userTurn?.parts).toEqual([
      { type: "text", text: "Tighten acceptance criteria" },
    ]);
    expect(promptText(process, 0)).toContain("Tighten acceptance criteria");
    expect(promptText(process, 0)).toContain("## Current Spec markdown (from editor)");
    expect(promptText(process, 0)).toContain("Draft body");
  });

  it("keeps Tasks tip JSON out of the transcript while framing the agent prompt", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-tasks");
    const transcripts: UIMessage[][] = [];

    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
      frameUserMessage: frameTasksAssistUserMessage,
    });
    bridge.attach(collectingSubscriber());

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "unused",
      history: [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "Here for you if you need me." }],
        },
      ],
    });

    const replyPromise = bridge.sendMessage("Split the API task", {
      liveDraftBody: '{\n  "tasks": []\n}',
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();
    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-tasks",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Updated." },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;

    const userTurn = transcripts.at(-1)?.find((m) => m.role === "user");
    expect(userTurn?.parts).toEqual([
      { type: "text", text: "Split the API task" },
    ]);
    expect(promptText(process, 0)).toContain("Split the API task");
    expect(promptText(process, 0)).toContain(
      "## Current tasks-draft tip JSON (from editor)",
    );
    expect(promptText(process, 0)).toContain('"tasks": []');
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

  it("runToCompletion runs one headless prompt turn then closes", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-headless");

    const bridge = new AcpBridge({ spawn: () => process });
    const done = bridge.runToCompletion({
      cwd: "C:/target-repo",
      prompt: "Synthesize the spec into exchange/card/spec.md",
      permissionPolicy: "cursor-like",
    });

    await viWaitFor(() => process.prompts().length === 1);
    expect(promptText(process, 0)).toBe(
      "Synthesize the spec into exchange/card/spec.md",
    );

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-headless",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Wrote the exchange file." },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await done;
    expect(process.killed).toBe(true);
  });

  it("runToCompletion auto-approves read permissions without a subscriber", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-headless-read");

    const bridge = new AcpBridge({ spawn: () => process });
    const done = bridge.runToCompletion({
      cwd: "C:/target-repo",
      prompt: "Read CONTEXT.md then write the spec",
      permissionPolicy: "cursor-like",
    });

    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();

    process.emit({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "sess-headless-read",
        toolCall: { toolCallId: "call_1", title: "Read file CONTEXT.md" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() =>
      process.written.some(
        (m) =>
          (m as { id?: number; result?: unknown }).id === 42 &&
          (m as { result?: unknown }).result !== undefined,
      ),
    );

    const reply = process.written.find(
      (m): m is { id: number; result: unknown } =>
        (m as { id?: number }).id === 42 &&
        (m as { result?: unknown }).result !== undefined,
    );
    expect(reply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(bridge.getPendingPermissionIds()).toEqual([]);

    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await done;
  });

  it("runToCompletion fails a disallowed write without stalling on UI", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-headless-write");

    const bridge = new AcpBridge({ spawn: () => process });
    const done = bridge.runToCompletion({
      cwd: "C:/target-repo",
      prompt: "Write something",
      permissionPolicy: "cursor-like",
    });

    await viWaitFor(() => process.prompts().length === 1);

    process.emit({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "sess-headless-write",
        toolCall: {
          toolCallId: "call_w",
          title: "Write file src/index.ts",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await expect(done).rejects.toThrow(/disallowed|write/i);
    expect(process.killed).toBe(true);

    const reply = process.written.find(
      (m): m is { id: number; result: unknown } =>
        (m as { id?: number }).id === 77 &&
        (m as { result?: unknown }).result !== undefined,
    );
    expect(reply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  it("runToCompletion auto-approves writes under the project-store exchange path", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-headless-ex");

    const bridge = new AcpBridge({ spawn: () => process });
    const done = bridge.runToCompletion({
      cwd: "C:/target-repo",
      prompt: "Write the spec exchange file",
      permissionPolicy: "cursor-like",
    });

    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();

    process.emit({
      jsonrpc: "2.0",
      id: 88,
      method: "session/request_permission",
      params: {
        sessionId: "sess-headless-ex",
        toolCall: {
          toolCallId: "call_ex",
          title: "Write file .jeeves/exchange/abc/spec.md",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() =>
      process.written.some(
        (m) =>
          (m as { id?: number; result?: unknown }).id === 88 &&
          (m as { result?: unknown }).result !== undefined,
      ),
    );

    const reply = process.written.find(
      (m): m is { id: number; result: unknown } =>
        (m as { id?: number }).id === 88 &&
        (m as { result?: unknown }).result !== undefined,
    );
    expect(reply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });

    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await done;
  });

  it("runToCompletion fails a shell permission without stalling on UI", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-headless-shell");

    const bridge = new AcpBridge({ spawn: () => process });
    const done = bridge.runToCompletion({
      cwd: "C:/target-repo",
      prompt: "Run a shell",
      permissionPolicy: "cursor-like",
    });

    await viWaitFor(() => process.prompts().length === 1);

    process.emit({
      jsonrpc: "2.0",
      id: 55,
      method: "session/request_permission",
      params: {
        sessionId: "sess-headless-shell",
        toolCall: { toolCallId: "call_sh", title: "Shell ls" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await expect(done).rejects.toThrow(/disallowed|write/i);
    expect(process.killed).toBe(true);
  });

  it("runToCompletion rejects on timeout", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-timeout");

    const bridge = new AcpBridge({ spawn: () => process });
    const done = bridge.runToCompletion({
      cwd: "C:/target-repo",
      prompt: "Hang forever",
      permissionPolicy: "cursor-like",
      timeoutMs: 30,
    });

    await viWaitFor(() => process.prompts().length === 1);
    await expect(done).rejects.toThrow(/timed out/i);
    expect(process.killed).toBe(true);
  });

  it("interactive cursor-like auto-approves reads without a permission UI chunk", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-live-read");

    const bridge = new AcpBridge({ spawn: () => process });
    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Assist with the spec",
      history: [],
      interactivePermissionPolicy: "cursor-like",
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();

    process.emit({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "sess-live-read",
        toolCall: { toolCallId: "call_r", title: "Read file CONTEXT.md" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() =>
      process.written.some(
        (m) =>
          (m as { id?: number; result?: unknown }).id === 77 &&
          (m as { result?: unknown }).result !== undefined,
      ),
    );

    expect(bridge.getPendingPermissionIds()).toEqual([]);
    expect(
      sub.chunks.some((c) => (c as { type?: string }).type === "data-permission"),
    ).toBe(false);

    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await bridge.whenIdle();
  });

  it("interactive cursor-like auto-approves shell without a permission UI chunk", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-live-shell");

    const bridge = new AcpBridge({ spawn: () => process });
    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Assist with the spec",
      history: [],
      interactivePermissionPolicy: "cursor-like",
    });
    await viWaitFor(() => process.prompts().length === 1);

    process.emit({
      jsonrpc: "2.0",
      id: 88,
      method: "session/request_permission",
      params: {
        sessionId: "sess-live-shell",
        toolCall: { toolCallId: "call_s", title: "Shell: dir" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() =>
      process.written.some(
        (m) =>
          (m as { id?: number; result?: unknown }).id === 88 &&
          (m as { result?: unknown }).result !== undefined,
      ),
    );

    expect(bridge.getPendingPermissionIds()).toEqual([]);
    expect(
      sub.chunks.some((c) => (c as { type?: string }).type === "data-permission"),
    ).toBe(false);
  });

  it("interactive cursor-like still prompts for non-exchange file writes", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-live-write");

    const bridge = new AcpBridge({ spawn: () => process });
    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Assist with the spec",
      history: [],
      interactivePermissionPolicy: "cursor-like",
    });
    await viWaitFor(() => process.prompts().length === 1);

    process.emit({
      jsonrpc: "2.0",
      id: 89,
      method: "session/request_permission",
      params: {
        sessionId: "sess-live-write",
        toolCall: { toolCallId: "call_w", title: "Write file src/app.ts" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    await viWaitFor(() => bridge.getPendingPermissionIds().includes("89"));
    expect(
      sub.chunks.some((c) => (c as { type?: string }).type === "data-permission"),
    ).toBe(true);

    bridge.respondToPermission("89", "reject-once");
    expect(bridge.getPendingPermissionIds()).toEqual([]);
  });

  it("cancelTurn sends session/cancel and cancels pending permissions", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-cancel");

    const bridge = new AcpBridge({ spawn: () => process });
    const sub = collectingSubscriber();
    bridge.attach(sub);

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: "Assist",
      history: [],
      interactivePermissionPolicy: "cursor-like",
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();

    process.emit({
      jsonrpc: "2.0",
      id: 90,
      method: "session/request_permission",
      params: {
        sessionId: "sess-cancel",
        toolCall: { toolCallId: "call_w", title: "Write file src/app.ts" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    await viWaitFor(() => bridge.getPendingPermissionIds().includes("90"));

    bridge.cancelTurn();

    expect(bridge.getPendingPermissionIds()).toEqual([]);
    expect(
      process.written.some(
        (m) =>
          (m as { method?: string }).method === "session/cancel" &&
          (m as { params?: { sessionId?: string } }).params?.sessionId ===
            "sess-cancel",
      ),
    ).toBe(true);
    expect(
      process.written.some(
        (m) =>
          (m as { id?: number; result?: { outcome?: { outcome?: string } } })
            .id === 90 &&
          (m as { result?: { outcome?: { outcome?: string } } }).result
            ?.outcome?.outcome === "cancelled",
      ),
    ).toBe(true);

    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "cancelled" },
    });
    await bridge.whenIdle();
    expect(
      sub.chunks.some((c) => (c as { type?: string }).type === "finish"),
    ).toBe(true);
  });

  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("captures initialize promptCapabilities (fail-closed when omitted)", async () => {
    const closed = new MockAcpProcess();
    closed.autoHandshake("sess-caps-off");
    const bridgeOff = new AcpBridge({
      spawn: () => closed,
      onTranscript: () => {},
    });
    await bridgeOff.openSession({
      cwd: "/repo",
      openingPrompt: null,
      history: [],
    });
    expect(bridgeOff.getPromptCapabilities()).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    });

    const open = new MockAcpProcess();
    open.autoHandshake("sess-caps-on", {
      promptCapabilities: { image: true },
    });
    const bridgeOn = new AcpBridge({
      spawn: () => open,
      onTranscript: () => {},
    });
    await bridgeOn.openSession({
      cwd: "/repo",
      openingPrompt: null,
      history: [],
    });
    expect(bridgeOn.getPromptCapabilities()).toEqual({
      image: true,
      audio: false,
      embeddedContext: false,
    });
  });

  it("sends image ContentBlocks on session/prompt and stores file parts", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-img", {
      promptCapabilities: { image: true },
    });
    const transcripts: UIMessage[][] = [];
    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
    });
    await bridge.openSession({
      cwd: "/repo",
      openingPrompt: null,
      history: [],
    });

    const replyPromise = bridge.sendMessage("What is this?", {
      attachments: [
        { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
      ],
    });
    await viWaitFor(() => process.prompts().length === 1);

    expect(process.prompts()[0]!.prompt).toEqual([
      { type: "text", text: "What is this?" },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    ]);

    const promptReq = process.promptRequest();
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;

    const user = transcripts.at(-1)?.find((m) => m.role === "user");
    expect(user?.parts).toEqual([
      { type: "text", text: "What is this?" },
      {
        type: "file",
        url: TINY_PNG,
        mediaType: "image/png",
        filename: "dot.png",
      },
    ]);
  });

  it("materializes data URLs to pointers before transcript persist", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-sidecar", {
      promptCapabilities: { image: true },
    });
    const transcripts: UIMessage[][] = [];
    const pointerUrl = "jeeves-attachment://chat/tid/aid1";
    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: (messages) => transcripts.push(messages),
      persistAttachments: (atts) =>
        atts.map((a) => ({ ...a, url: pointerUrl })),
      resolveAttachmentBytes: () => ({
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      }),
    });
    await bridge.openSession({
      cwd: "/repo",
      openingPrompt: null,
      history: [],
    });

    const replyPromise = bridge.sendMessage("What is this?", {
      attachments: [
        { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
      ],
    });
    await viWaitFor(() => process.prompts().length === 1);
    const promptReq = process.promptRequest();
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;

    const user = transcripts.at(-1)?.find((m) => m.role === "user");
    const filePart = user?.parts.find((p) => p.type === "file") as {
      url: string;
    };
    expect(filePart.url).toBe(pointerUrl);
    expect(process.prompts()[0]!.prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]),
    );
  });

  it("rejects unsupported attachments before prompting", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-reject");
    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: () => {},
    });
    await bridge.openSession({
      cwd: "/repo",
      openingPrompt: null,
      history: [],
    });

    await expect(
      bridge.sendMessage("see this", {
        attachments: [
          { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
        ],
      }),
    ).rejects.toThrow(/not supported|does not accept image/i);
    expect(process.prompts()).toHaveLength(0);
    expect(bridge.getMessages()).toHaveLength(0);
  });

  it("reseeds prior image attachments on cold resume", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-seed-img", {
      promptCapabilities: { image: true },
    });
    const bridge = new AcpBridge({
      spawn: () => process,
      onTranscript: () => {},
    });
    await bridge.openSession({
      cwd: "/repo",
      openingPrompt: "unused",
      history: [
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
          parts: [{ type: "text", text: "A pixel." }],
        },
      ],
    });

    const replyPromise = bridge.sendMessage("Again?");
    await viWaitFor(() => process.prompts().length === 1);
    const prompt = process.prompts()[0]!.prompt as Array<{
      type: string;
      text?: string;
    }>;
    expect(prompt[0]!.type).toBe("text");
    expect(prompt[0]!.text).toContain("[attached: dot.png (image/png)]");
    expect(prompt[0]!.text).toContain("User: Again?");
    // Prior images are emitted before any latest-turn attachment blocks.
    const imageIndexes = prompt
      .map((b, i) => (b.type === "image" ? i : -1))
      .filter((i) => i >= 0);
    expect(imageIndexes.length).toBeGreaterThan(0);
    expect(imageIndexes[0]).toBe(1);

    const promptReq = process.promptRequest();
    process.emit({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });
    await replyPromise;
  });
});

/**
 * `adopt` is what lets a pre-warmed spare be handed to a chat: everything after
 * the handshake, with no ACP traffic of its own.
 */
describe("AcpBridge.adopt", () => {
  async function warmBridge(sessionId: string) {
    const process = new MockAcpProcess();
    process.autoHandshake(sessionId, { models: MOCK_MODEL_OPTION });
    const bridge = new AcpBridge({ spawn: () => process });
    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });
    return { bridge, process };
  }

  it("binds history onto a handshaked session without touching the process", async () => {
    const { bridge, process } = await warmBridge("sess-adopt-history");
    const history: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];

    bridge.adopt({ openingPrompt: "should not be sent", history });

    expect(bridge.getMessages()).toEqual(history);
    await new Promise((r) => setTimeout(r, 20));
    expect(process.prompts()).toHaveLength(0);
  });

  it("fires the opening turn when adopted with empty history", async () => {
    const { bridge, process } = await warmBridge("sess-adopt-opener");

    bridge.adopt({ openingPrompt: "Grill me", history: [] });

    await viWaitFor(() => process.prompts().length === 1);
    expect(promptText(process)).toBe("Grill me");
  });

  it("routes callbacks rewired after the handshake to the adopting chat", async () => {
    const { bridge, process } = await warmBridge("sess-adopt-callbacks");
    const statuses: Array<"ai-working" | "needs-user"> = [];
    bridge.setLiveCallbacks({
      onStatus: (status) => statuses.push(status),
      onTranscript: () => {},
    });

    bridge.adopt({ openingPrompt: "Go", history: [] });

    await viWaitFor(() => statuses.length > 0);
    expect(statuses[0]).toBe("ai-working");
    expect(process.prompts()).toHaveLength(1);
  });

  it("refuses to adopt before the handshake has landed", () => {
    const bridge = new AcpBridge({ spawn: () => new MockAcpProcess() });
    expect(() => bridge.adopt({ openingPrompt: null, history: [] })).toThrow(
      /session not open/i,
    );
  });
});

describe("AcpBridge model config option", () => {
  it("captures the model selector from session/new", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-model-opt", { models: MOCK_MODEL_OPTION });
    const bridge = new AcpBridge({ spawn: () => process });

    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    expect(bridge.getModelOption()?.id).toBe("model");
    expect(bridge.getCurrentModelValue()).toBe("default[]");
  });

  it("switches model in place and adopts the agent's echoed config state", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-model-set", { models: MOCK_MODEL_OPTION });
    const bridge = new AcpBridge({ spawn: () => process });
    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    await bridge.setModelValue("gpt-5.5[]");

    expect(bridge.getCurrentModelValue()).toBe("gpt-5.5[]");
    expect(process.currentModel()).toBe("gpt-5.5[]");
    expect(process.killed).toBe(false);
  });

  it("skips the RPC when the session is already on that model", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-model-noop", { models: MOCK_MODEL_OPTION });
    const bridge = new AcpBridge({ spawn: () => process });
    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    await bridge.setModelValue("default[]");

    expect(process.modelRequests()).toEqual([]);
  });

  it("throws for an agent that advertises no model selector", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-no-models");
    const bridge = new AcpBridge({ spawn: () => process });
    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    expect(bridge.getModelOption()).toBeNull();
    await expect(bridge.setModelValue("gpt-5.5[]")).rejects.toThrow(
      /model selector/i,
    );
  });

  it("reports an agent-initiated switch via config_option_update", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-model-notify", { models: MOCK_MODEL_OPTION });
    const changes: string[] = [];
    const bridge = new AcpBridge({
      spawn: () => process,
      onModelChanged: (value) => changes.push(value),
    });
    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-model-notify",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              category: "model",
              type: "select",
              currentValue: "composer-2.5[fast=true]",
              options: MOCK_MODEL_OPTION.values.map((value) => ({
                value,
                name: value,
              })),
            },
          ],
        },
      },
    });

    await viWaitFor(() => changes.length > 0);
    expect(changes).toEqual(["composer-2.5[fast=true]"]);
    expect(bridge.getCurrentModelValue()).toBe("composer-2.5[fast=true]");
  });

  it("ignores a config_option_update that does not move the model", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-model-same", { models: MOCK_MODEL_OPTION });
    const changes: string[] = [];
    const bridge = new AcpBridge({
      spawn: () => process,
      onModelChanged: (value) => changes.push(value),
    });
    await bridge.openSession({
      cwd: "C:/target-repo",
      openingPrompt: null,
      history: [],
    });

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-model-same",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "mode", category: "mode", type: "select", currentValue: "plan" },
          ],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(changes).toEqual([]);
    expect(bridge.getCurrentModelValue()).toBe("default[]");
  });
});

describe("decideInteractivePermission", () => {
  const options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  it("allows reads, shell, and exchange writes under cursor-like", () => {
    expect(
      decideInteractivePermission(
        { title: "Read file CONTEXT.md", options },
        "cursor-like",
      ),
    ).toEqual({ action: "allow", optionId: "allow-once" });
    expect(
      decideInteractivePermission(
        { title: "Shell: npm test", options },
        "cursor-like",
      ),
    ).toEqual({ action: "allow", optionId: "allow-once" });
    expect(
      decideInteractivePermission(
        {
          title: "Write file .jeeves/exchange/c1/spec.md",
          options,
        },
        "cursor-like",
      ),
    ).toEqual({ action: "allow", optionId: "allow-once" });
  });

  it("auto-approves raw shell titles even when the command text contains Write", () => {
    expect(
      decideInteractivePermission(
        {
          title:
            'rg -n "Streaming lock|revised exchange|Smoke QA|Write|tasks-draft|exchange" "C:\\Users\\robin\\.cursor\\projects\\foo\\agent-transcripts\\x.jsonl" | Select-Object -First 40',
          options,
        },
        "cursor-like",
      ),
    ).toEqual({ action: "allow", optionId: "allow-once" });
  });

  it("prompts for non-exchange file writes under cursor-like", () => {
    expect(
      decideInteractivePermission(
        { title: "Write file src/app.ts", options },
        "cursor-like",
      ),
    ).toEqual({ action: "prompt" });
  });

  it("project-chat auto-approves reads but prompts for shell, writes, and unknowns", () => {
    expect(
      decideInteractivePermission(
        { title: "Read file CONTEXT.md", options },
        "project-chat",
      ),
    ).toEqual({ action: "allow", optionId: "allow-once" });
    expect(
      decideInteractivePermission(
        { title: "Shell: npm test", options },
        "project-chat",
      ),
    ).toEqual({ action: "prompt" });
    expect(
      decideInteractivePermission(
        { title: "Write file src/app.ts", options },
        "project-chat",
      ),
    ).toEqual({ action: "prompt" });
    expect(
      decideInteractivePermission(
        {
          title: "Write file .jeeves/exchange/c1/spec.md",
          options,
        },
        "project-chat",
      ),
    ).toEqual({ action: "prompt" });
    expect(
      decideInteractivePermission(
        { title: "MysteriousTool doSomething", options },
        "project-chat",
      ),
    ).toEqual({ action: "prompt" });
  });
});

describe("decideHeadlessPermission", () => {
  const options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  it("allows shell that inspects the exchange path", () => {
    expect(
      decideHeadlessPermission({
        title:
          '`Format-Hex -Path "C:\\repo\\.jeeves\\exchange\\c1\\tasks-draft.json" -Count 64; Write-Host "---"; Get-Content "C:\\repo\\.jeeves\\exchange\\c1\\tasks-draft.json" -Raw`',
        options,
      }),
    ).toEqual({ action: "allow", optionId: "allow-once" });
  });

  it("denies shell outside the exchange path", () => {
    expect(
      decideHeadlessPermission({ title: "Shell: ls", options }).action,
    ).toBe("deny");
  });
});
