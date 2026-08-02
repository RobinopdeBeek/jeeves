import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb } from "../db/index.js";
import { EventBus } from "../execution/events.js";
import {
  createStepChatSession,
  stepChatSessionId,
} from "./chat-session.js";
import { MockAcpProcess, viWaitFor } from "./mock-acp-process.js";
import { openChat } from "./open-chat.js";
import { ChatSessionRegistry } from "./session-registry.js";

const promptsRoot = path.resolve(import.meta.dirname, "../../prompts");

describe("stepChatSessionId", () => {
  it("builds an opaque server id clients cannot invent as a bare triple", () => {
    expect(stepChatSessionId("c1", "grill", 0)).toBe("card:c1:grill:0");
    expect(stepChatSessionId("c1", "spec", 2)).toBe("card:c1:spec:2");
    expect(stepChatSessionId("c1", "tasks", 0)).toBe("card:c1:tasks:0");
  });
});

describe("createStepChatSession", () => {
  let db: ReturnType<typeof openDb>;
  let store: CardStore;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let events: EventBus;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-chat-session-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    events = new EventBus();
    const projectId = store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    cardId = store.createCard(projectId).id;
    store.updateCard(cardId, { title: "Pantry", description: "Expiry alerts" });
    store.decideKind(cardId, "feature");
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("carries opaque id, cwd, opening prompt, and policy hooks for grill", () => {
    const session = createStepChatSession(
      { cardId, stepKey: "grill", round: 0 },
      { store, artifacts, events, promptsRoot },
    );

    expect(session.id).toBe(`card:${cardId}:grill:0`);
    expect(session.cwd).toBe("C:/target-repo");
    expect(session.openingPrompt).toEqual(expect.stringContaining("Pantry"));
    expect(session.interactivePermissionPolicy).toBeUndefined();
    expect(session.loadTranscript()).toEqual([]);
    expect(() => session.assertMutable()).not.toThrow();
  });

  it("uses cursor-like policy for spec assist", () => {
    const session = createStepChatSession(
      { cardId, stepKey: "spec", round: 0 },
      { store, artifacts, events, promptsRoot },
    );
    expect(session.id).toBe(`card:${cardId}:spec:0`);
    expect(session.interactivePermissionPolicy).toBe("cursor-like");
    expect(session.frameUserMessage).toBeTypeOf("function");
  });

  it("rejects missing cards at the factory", () => {
    expect(() =>
      createStepChatSession(
        { cardId: "missing", stepKey: "grill", round: 0 },
        { store, artifacts, events, promptsRoot },
      ),
    ).toThrow(/card not found/i);
  });
});

describe("openChat via ChatSession", () => {
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
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-open-session-"));
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

  it("registers the warm bridge under the opaque session id", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-opaque");
    const session = createStepChatSession(
      { cardId, stepKey: "grill", round: 0 },
      { store, artifacts, events, promptsRoot },
    );

    const opened = await openChat(session, { spawn: () => process, sessions });
    expect(opened.handle.reused).toBe(false);
    expect(sessions.hasWarm(session.id)).toBe(true);
    expect(sessions.hasWarm(`card:${cardId}:grill:0`)).toBe(true);

    await viWaitFor(() => process.prompts().length === 1);
  });

  it("does not auto-fire when openingPrompt is null and history is empty", async () => {
    const process = new MockAcpProcess();
    process.autoHandshake("sess-null-opener");
    const session = createStepChatSession(
      { cardId, stepKey: "grill", round: 0 },
      { store, artifacts, events, promptsRoot },
    );
    // Project Chat shape: warm ACP, user-first (no opening monologue).
    const userFirst = { ...session, openingPrompt: null };

    await openChat(userFirst, { spawn: () => process, sessions });
    await new Promise((r) => setTimeout(r, 30));
    expect(process.prompts()).toHaveLength(0);
    expect(sessions.hasWarm(userFirst.id)).toBe(true);
  });
});
