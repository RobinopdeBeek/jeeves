import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb } from "../db/index.js";
import { EventBus } from "../execution/events.js";
import { MockAcpProcess, viWaitFor } from "./mock-acp-process.js";
import { openChat, resolveOpeningPrompt } from "./open-chat.js";
import { ChatSessionRegistry } from "./session-registry.js";

const promptsRoot = path.resolve(import.meta.dirname, "../../prompts");

describe("resolveOpeningPrompt", () => {
  it("builds a grill opener from the chat template", () => {
    const prompt = resolveOpeningPrompt(
      "grill",
      { title: "Pantry", description: "Track expiry" },
      "C:/repo",
      promptsRoot,
    );
    expect(prompt).toContain("Pantry");
    expect(prompt).toContain("Track expiry");
    expect(prompt).toContain(path.join("C:/repo", "CONTEXT.md"));
  });

  it("rejects unknown step keys", () => {
    expect(() =>
      resolveOpeningPrompt(
        "plan",
        { title: "x", description: "y" },
        "C:/repo",
        promptsRoot,
      ),
    ).toThrow(/no opening prompt/i);
  });
});

describe("openChat", () => {
  let db: ReturnType<typeof openDb>;
  let store: CardStore;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let events: EventBus;
  let sessions: ChatSessionRegistry;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-open-chat-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    events = new EventBus();
    sessions = new ChatSessionRegistry();
    const projectId = store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    cardId = store.createCard(projectId).id;
    store.updateCard(cardId, { title: "Pantry", description: "Expiry alerts" });
    store.decideKind(cardId, "feature");
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("loads empty history, acquires a cold bridge, and wires status + transcript", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-open");
    const statuses: Array<"ai-working" | "needs-user"> = [];
    const busCards: string[] = [];
    events.subscribe((e) => {
      if (e.type === "card.updated") busCards.push(e.card.id);
    });

    const opened = await openChat(
      { cardId, stepKey: "grill", round: 0 },
      {
        store,
        artifacts,
        events,
        spawn: () => process,
        promptsRoot,
        sessions,
      },
      { onStatusNotify: (s) => statuses.push(s) },
    );

    expect(opened.history).toEqual([]);
    expect(opened.handle.reused).toBe(false);
    expect(sessions.hasWarm({ cardId, stepKey: "grill", round: 0 })).toBe(true);

    await viWaitFor(() => process.prompts().length === 1);
    expect(process.prompts()[0].prompt).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Pantry"),
      },
    ]);

    process.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-open",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "First Q?" },
        },
      },
    });
    process.emit({
      jsonrpc: "2.0",
      id: process.promptRequest().id,
      result: { stopReason: "end_turn" },
    });

    await opened.handle.bridge.whenIdle();

    expect(statuses[0]).toBe("ai-working");
    expect(statuses.at(-1)).toBe("needs-user");
    expect(busCards.length).toBeGreaterThan(0);
    expect(store.getCard(cardId)?.steps.find((s) => s.key === "grill")?.status).toBe(
      "needs-user",
    );

    const latest = artifacts.latest(cardId, {
      stepKey: "grill",
      round: 0,
      kind: "transcript",
    });
    expect(latest).toBeDefined();
    const saved = JSON.parse(artifacts.readContent(latest!)) as UIMessage[];
    expect(saved[0]?.parts).toEqual([{ type: "text", text: "First Q?" }]);
  });

  it("reuses a warm bridge and returns persisted history", async () => {
    const history: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Already asked" }],
      },
    ];
    artifacts.upsertTranscript(cardId, "grill", 0, history);

    const process = new MockAcpProcess();
    process.autoHandshake("sess-warm");
    let spawnCount = 0;

    const first = await openChat(
      { cardId, stepKey: "grill", round: 0 },
      {
        store,
        artifacts,
        events,
        spawn: () => {
          spawnCount += 1;
          return process;
        },
        promptsRoot,
        sessions,
      },
    );
    expect(first.history).toEqual(history);
    expect(first.handle.reused).toBe(false);
    expect(process.prompts()).toHaveLength(0);

    const second = await openChat(
      { cardId, stepKey: "grill", round: 0 },
      {
        store,
        artifacts,
        events,
        spawn: () => {
          spawnCount += 1;
          return process;
        },
        promptsRoot,
        sessions,
      },
    );
    expect(second.handle.reused).toBe(true);
    expect(spawnCount).toBe(1);
    expect(second.history).toEqual(history);
  });

  it("rejects when the grill transcript is frozen", async () => {
    store.setStepStatus(cardId, "grill", "done");
    const process = new MockAcpProcess();
    process.autoHandshake("sess-frozen");

    await expect(
      openChat(
        { cardId, stepKey: "grill", round: 0 },
        {
          store,
          artifacts,
          events,
          spawn: () => process,
          promptsRoot,
          sessions,
        },
      ),
    ).rejects.toThrow(/frozen/i);
  });

  it("rejects missing cards", async () => {
    await expect(
      openChat(
        { cardId: "missing", stepKey: "grill", round: 0 },
        {
          store,
          artifacts,
          events,
          spawn: () => new MockAcpProcess(),
          promptsRoot,
          sessions,
        },
      ),
    ).rejects.toThrow(/card not found/i);
  });
});
