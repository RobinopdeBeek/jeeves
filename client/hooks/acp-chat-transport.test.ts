import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import { AcpChatTransport } from "./acp-chat-transport";

type MessageHandler = (event: { data: string }) => void;

/**
 * Minimal WebSocket stand-in for AcpChatTransport unit tests.
 * Vitest runs in node — no real WebSocket / window.
 */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onmessage: MessageHandler | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  addEventListener(type: string, handler: () => void): void {
    if (type === "open") handler();
  }

  /** Deliver a server JSON message as the browser would. */
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  static instances: FakeWebSocket[] = [];
  static install(): void {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3000" },
    });
  }
}

function userMessage(text: string): UIMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

async function readAll(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("AcpChatTransport", () => {
  beforeEach(() => {
    FakeWebSocket.install();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not throw when a chunk arrives after the consumer cancels the stream", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: true });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: true });

    const resume = await transport.reconnectToStream();
    expect(resume).not.toBeNull();
    const reader = resume!.getReader();

    // assistant-ui / AI SDK may cancel the resume stream when the user sends
    // (or on teardown) without going through our abortSignal path.
    await reader.cancel();

    // Server chunk for the in-flight opening turn — must not throw.
    expect(() => {
      ws.deliver({
        type: "chunk",
        chunk: { type: "text-delta", id: "t1", delta: "Hello" },
      });
    }).not.toThrow();
  });

  it("still delivers chunks on sendMessages after a cancelled resume stream", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: true });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: true });

    const resume = await transport.reconnectToStream();
    await resume!.getReader().cancel();

    const sendP = transport.sendMessages({
      messages: [userMessage("hi")],
      abortSignal: undefined as unknown as AbortSignal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);

    // Allow sendMessages to open its stream and post user-message.
    await Promise.resolve();
    const stream = await sendP;
    const readP = readAll(stream);

    ws.deliver({
      type: "chunk",
      chunk: { type: "start", messageId: "a1" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "text-delta", id: "t1", delta: "hey" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "finish", finishReason: "stop" },
    });

    const chunks = await readP;
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-delta",
      "finish",
    ]);
  });

  it("late cancel of an old resume stream does not detach the send stream", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: true });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: true });

    const resume = await transport.reconnectToStream();
    const resumeReader = resume!.getReader();

    const stream = await transport.sendMessages({
      messages: [userMessage("hi")],
      abortSignal: undefined as unknown as AbortSignal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    const readP = readAll(stream);

    // Cancel the superseded resume stream after send has attached.
    await resumeReader.cancel();

    ws.deliver({
      type: "chunk",
      chunk: { type: "start", messageId: "a1" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "finish", finishReason: "stop" },
    });

    const chunks = await readP;
    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
  });

  it("re-attaches opening chunks after the first resume stream is cancelled mid-turn", async () => {
    // useChat recreates its Chat when the assistant-ui thread id changes and
    // cancels the in-flight resume stream without calling resume again. The
    // transport must allow a second reconnectToStream while the turn is live.
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: true });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: true });

    const first = await transport.reconnectToStream();
    expect(first).not.toBeNull();
    await first!.getReader().cancel();

    const second = await transport.reconnectToStream();
    expect(second).not.toBeNull();
    const readP = readAll(second!);

    ws.deliver({
      type: "chunk",
      chunk: { type: "start", messageId: "a1" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "text-delta", id: "t1", delta: "First question?" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "finish", finishReason: "stop" },
    });

    const chunks = await readP;
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-delta",
      "finish",
    ]);
  });

  it("keeps the opening stream open when session reports idle before chunks arrive", async () => {
    // ready is sent before openChat; session can briefly report streaming:false
    // while the opening turn is still starting. That must not close an empty
    // resume stream and drop the first question.
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;

    const resume = await transport.reconnectToStream();
    expect(resume).not.toBeNull();
    const readP = readAll(resume!);

    ws.deliver({ type: "session", status: "open", streaming: false });
    ws.deliver({
      type: "chunk",
      chunk: { type: "start", messageId: "a1" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "text-delta", id: "t1", delta: "What problem?" },
    });
    ws.deliver({
      type: "chunk",
      chunk: { type: "finish", finishReason: "stop" },
    });

    const chunks = await readP;
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-delta",
      "finish",
    ]);
  });

  it("frames Spec user turns with currentSpecMarkdown from the editor", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "spec",
      getCurrentSpecMarkdown: () => "# Spec\n\nDraft body\n",
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({
      type: "ready",
      messages: [{ id: "a0", role: "assistant", parts: [{ type: "text", text: "Ready" }] }],
      streaming: false,
    });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    const stream = await transport.sendMessages({
      messages: [userMessage("Tighten acceptance criteria")],
      abortSignal: undefined as unknown as AbortSignal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    void readAll(stream);

    const sent = ws.sent.map((s) => JSON.parse(s) as { type: string; text?: string });
    const userMsg = sent.find((m) => m.type === "user-message");
    expect(userMsg?.text).toContain("Tighten acceptance criteria");
    expect(userMsg?.text).toContain("## Current Spec markdown (from editor)");
    expect(userMsg?.text).toContain("Draft body");
  });

  it("notifies onSpecRevised when the server harvests a Spec revision", async () => {
    const revisions: string[] = [];
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "spec",
      onSpecRevised: (markdown) => revisions.push(markdown),
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    ws.deliver({
      type: "spec-revised",
      markdown: "# Spec\n\nRevised by assist\n",
    });

    expect(revisions).toEqual(["# Spec\n\nRevised by assist\n"]);
  });
});
