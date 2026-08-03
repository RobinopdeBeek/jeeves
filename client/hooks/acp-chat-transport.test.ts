import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  AcpChatTransport,
  type ChatConnectionState,
} from "./acp-chat-transport";

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
    vi.useRealTimers();
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

  it("sends Spec markdown as background context, not in the visible user text", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "spec",
      getLiveDraftBody: () => "# Spec\n\nDraft body\n",
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

    const sent = ws.sent.map(
      (s) =>
        JSON.parse(s) as {
          type: string;
          text?: string;
          liveDraftBody?: string;
        },
    );
    const userMsg = sent.find((m) => m.type === "user-message");
    expect(userMsg?.text).toBe("Tighten acceptance criteria");
    expect(userMsg?.liveDraftBody).toContain("Draft body");
    expect(userMsg?.text).not.toContain("Current Spec markdown");
  });

  it("recovers a silently dead socket on send instead of hanging", async () => {
    // Dev-server restart / HMR can leave a CLOSED socket with no close event.
    // The pre-send health check must reconnect and deliver on the new socket.
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });
    const history: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Ready" }] },
    ];

    const connectP = transport.connect();
    const dead = FakeWebSocket.instances[0]!;
    dead.deliver({ type: "ready", messages: history, streaming: false });
    await connectP;
    dead.deliver({ type: "session", status: "open", streaming: false });

    dead.readyState = FakeWebSocket.CLOSED;

    const sendP = transport.sendMessages({
      messages: [userMessage("hi")],
      abortSignal: undefined as unknown as AbortSignal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);

    // ensureLive opens a replacement socket before committing the turn.
    const fresh = FakeWebSocket.instances[1]!;
    expect(fresh).toBeDefined();
    fresh.deliver({ type: "ready", messages: history, streaming: false });
    fresh.deliver({ type: "session", status: "open", streaming: false });

    const stream = await sendP;
    const readP = readAll(stream);
    fresh.deliver({ type: "chunk", chunk: { type: "start", messageId: "a2" } });
    fresh.deliver({ type: "chunk", chunk: { type: "finish", finishReason: "stop" } });

    expect((await readP).map((c) => c.type)).toEqual(["start", "finish"]);
    const sent = fresh.sent.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(sent).toContainEqual({ type: "user-message", text: "hi" });
    // Nothing was lost into the dead socket.
    expect(dead.sent).toEqual([]);
  });

  it("reconnects after an unexpected close and re-seeds the transcript", async () => {
    vi.useFakeTimers();
    const reconnected: UIMessage[][] = [];
    const states: ChatConnectionState[] = [];
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
      onConnectionChange: (state) => states.push(state),
      onReconnected: (history) => reconnected.push(history),
    });

    const connectP = transport.connect();
    const first = FakeWebSocket.instances[0]!;
    first.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    first.deliver({ type: "session", status: "open", streaming: false });
    expect(transport.isSessionOpen()).toBe(true);

    first.readyState = FakeWebSocket.CLOSED;
    first.onclose?.();

    // Composer must stop accepting sends the moment the socket is gone.
    expect(transport.isSessionOpen()).toBe(false);
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(500);

    const second = FakeWebSocket.instances[1]!;
    expect(second).toBeDefined();
    const history: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Question?" }] },
    ];
    second.deliver({ type: "ready", messages: history, streaming: false });
    second.deliver({ type: "session", status: "open", streaming: false });

    expect(reconnected).toEqual([history]);
    expect(transport.isSessionOpen()).toBe(true);
    expect(states.at(-1)).toBe("open");
  });

  it("pings a quiet socket before sending and proceeds once the server pongs", async () => {
    vi.useFakeTimers();
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });
    const history: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Ready" }] },
    ];

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: history, streaming: false });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    // Idle past the "provably fresh" window, so liveness needs a round trip.
    await vi.advanceTimersByTimeAsync(4000);

    const sendP = transport.sendMessages({
      messages: [userMessage("still there?")],
      abortSignal: undefined as unknown as AbortSignal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);

    const ping = JSON.parse(ws.sent.at(-1)!) as { type: string; id: string };
    expect(ping.type).toBe("ping");
    ws.deliver({ type: "pong", id: ping.id });

    await sendP;
    const sent = ws.sent.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(sent).toContainEqual({ type: "user-message", text: "still there?" });
    // No reconnect was needed.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("sends cancel and unlocks streaming when the abort signal fires (Stop)", async () => {
    const streaming: boolean[] = [];
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "tasks",
      onStreamingChange: (s) => streaming.push(s),
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({
      type: "ready",
      messages: [
        { id: "a0", role: "assistant", parts: [{ type: "text", text: "Ready" }] },
      ],
      streaming: false,
    });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    const abort = new AbortController();
    const stream = await transport.sendMessages({
      messages: [userMessage("Rename the first task")],
      abortSignal: abort.signal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    const readP = readAll(stream);

    expect(streaming.at(-1)).toBe(true);

    abort.abort();
    await readP;

    const sent = ws.sent.map((s) => JSON.parse(s) as { type: string });
    expect(sent).toContainEqual({ type: "cancel" });
    expect(streaming.at(-1)).toBe(false);
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

  it("sends Tasks tip JSON as background context, not in the visible user text", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "tasks",
      getLiveDraftBody: () => '{\n  "tasks": []\n}',
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({
      type: "ready",
      messages: [
        { id: "a0", role: "assistant", parts: [{ type: "text", text: "Ready" }] },
      ],
      streaming: false,
    });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    const stream = await transport.sendMessages({
      messages: [userMessage("Split the API task")],
      abortSignal: undefined as unknown as AbortSignal,
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    void readAll(stream);

    const sent = ws.sent.map(
      (s) =>
        JSON.parse(s) as {
          type: string;
          text?: string;
          liveDraftBody?: string;
        },
    );
    const userMsg = sent.find((m) => m.type === "user-message");
    expect(userMsg?.text).toBe("Split the API task");
    expect(userMsg?.liveDraftBody).toContain('"tasks": []');
    expect(userMsg?.text).not.toContain("tasks-draft tip JSON");
  });

  it("notifies onTasksRevised when the server harvests a Tasks revision", async () => {
    const revisions: Array<{ tasks: Array<{ id: string }> }> = [];
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "tasks",
      onTasksRevised: (draft) => revisions.push(draft),
    });

    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    ws.deliver({
      type: "tasks-revised",
      draft: {
        tasks: [
          { id: "a", title: "API", description: "", dependsOn: [] },
        ],
      },
      versionCount: 2,
    });

    expect(revisions).toEqual([
      {
        tasks: [{ id: "a", title: "API", description: "", dependsOn: [] }],
        versionCount: 2,
      },
    ]);
  });

  it("opens Project Chat with a threadId query (no card step coords)", async () => {
    const transport = new AcpChatTransport({ threadId: "thr-1" });
    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost:3000/ws/chat?threadId=thr-1");
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });
    expect(transport.isSessionOpen()).toBe(true);
  });

  it("stores promptCapabilities from session/open and sends file attachments", async () => {
    const TINY_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });
    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    expect(transport.getPromptCapabilities()).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    });
    ws.deliver({
      type: "session",
      status: "open",
      streaming: false,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    });
    expect(transport.getPromptCapabilities()).toEqual({
      image: true,
      audio: false,
      embeddedContext: false,
    });

    const stream = await transport.sendMessages({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "see this" },
            {
              type: "file",
              url: TINY_PNG,
              mediaType: "image/png",
              filename: "dot.png",
            },
          ],
        },
      ],
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    void readAll(stream);

    const sent = ws.sent.map((s) => JSON.parse(s) as unknown);
    expect(sent).toContainEqual({
      type: "user-message",
      text: "see this",
      attachments: [
        { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
      ],
    });
  });

  it("prepends quoted message text as a markdown blockquote on send", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });
    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    const stream = await transport.sendMessages({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "what about this?" }],
          metadata: {
            custom: {
              quote: { text: "selected span", messageId: "a1" },
            },
          },
        },
      ],
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    void readAll(stream);

    const sent = ws.sent.map((s) => JSON.parse(s) as unknown);
    expect(sent).toContainEqual({
      type: "user-message",
      text: "> selected span\n\nwhat about this?",
    });
  });

  it("sends a quote-only turn when the composer text is empty", async () => {
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });
    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    ws.deliver({ type: "session", status: "open", streaming: false });

    const stream = await transport.sendMessages({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [],
          metadata: {
            custom: {
              quote: { text: "line one\nline two", messageId: "a1" },
            },
          },
        },
      ],
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    void readAll(stream);

    const sent = ws.sent.map((s) => JSON.parse(s) as unknown);
    expect(sent).toContainEqual({
      type: "user-message",
      text: "> line one\n> line two\n\n",
    });
  });

  it("sends attachment-only user turns", async () => {
    const TINY_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const transport = new AcpChatTransport({
      cardId: "c1",
      stepKey: "grill",
    });
    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.deliver({ type: "ready", messages: [], streaming: false });
    await connectP;
    ws.deliver({
      type: "session",
      status: "open",
      streaming: false,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    });

    const stream = await transport.sendMessages({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            {
              type: "file",
              url: TINY_PNG,
              mediaType: "image/png",
              filename: "dot.png",
            },
          ],
        },
      ],
    } as Parameters<AcpChatTransport["sendMessages"]>[0]);
    void readAll(stream);

    const sent = ws.sent.map((s) => JSON.parse(s) as unknown);
    expect(sent).toContainEqual({
      type: "user-message",
      text: "",
      attachments: [
        { mediaType: "image/png", filename: "dot.png", url: TINY_PNG },
      ],
    });
  });
});
