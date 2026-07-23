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
});
