import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb } from "../db/index.js";
import { EventBus } from "../execution/events.js";
import { ChatThreadStore } from "../chat-threads/store.js";
import {
  createProjectChatSession,
  createStepChatSession,
  stepChatSessionId,
  threadChatSessionId,
} from "./chat-session.js";
import {
  MOCK_MODEL_OPTION,
  MockAcpProcess,
  viWaitFor,
} from "./mock-acp-process.js";
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

describe("threadChatSessionId", () => {
  it("builds an opaque thread id for the shared warm pool", () => {
    expect(threadChatSessionId("abc123")).toBe("thread:abc123");
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

  it("uses cursor-like policy and framing for tasks assist", () => {
    const session = createStepChatSession(
      { cardId, stepKey: "tasks", round: 0 },
      { store, artifacts, events, promptsRoot },
    );
    expect(session.id).toBe(`card:${cardId}:tasks:0`);
    expect(session.openingPrompt).toEqual(expect.stringContaining("Pantry"));
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

describe("createProjectChatSession", () => {
  let db: ReturnType<typeof openDb>;
  let store: CardStore;
  let chatRoot: string;
  let threads: ChatThreadStore;
  let projectId: string;
  let threadId: string;
  const repoPath = "C:/target-repo";

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    projectId = store.ensureDefaultProject("jeeves", repoPath).id;
    chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-project-chat-"));
    threads = new ChatThreadStore(db, chatRoot);
    threadId = threads.createOrReuseEmptyDraft(projectId).id;
  });

  afterEach(() => {
    fs.rmSync(chatRoot, { recursive: true, force: true });
  });

  it("warms Project Chat with null opener, project cwd, and project-chat policy", () => {
    const session = createProjectChatSession(
      { threadId },
      { threads, cwd: repoPath },
    );

    expect(session.id).toBe(`thread:${threadId}`);
    expect(session.cwd).toBe(repoPath);
    expect(session.openingPrompt).toBeNull();
    expect(session.model).toBeNull();
    expect(session.interactivePermissionPolicy).toBe("project-chat");
    expect(session.loadTranscript()).toEqual([]);
    expect(() => session.assertMutable()).not.toThrow();
  });

  it("exposes the thread's pinned model on the ChatSession", () => {
    threads.setModel(threadId, "composer-2.5");
    const session = createProjectChatSession(
      { threadId },
      { threads, cwd: repoPath },
    );
    expect(session.model).toBe("composer-2.5");
  });

  it("applies the thread's pinned model to the session, not the spawn", async () => {
    threads.setModel(threadId, "composer-2.5");
    const sessions = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-model", { models: MOCK_MODEL_OPTION });
    const spawnCalls: string[] = [];
    const session = createProjectChatSession(
      { threadId },
      { threads, cwd: repoPath },
    );

    await openChat(session, {
      spawn: (cwd) => {
        spawnCalls.push(cwd);
        return process;
      },
      sessions,
    });

    expect(spawnCalls).toEqual([repoPath]);
    // Legacy bare id migrated onto the agent's variant string.
    expect(process.modelRequests()).toEqual(["composer-2.5[fast=true]"]);
    expect(sessions.hasWarm(`thread:${threadId}`)).toBe(true);
  });

  it("leaves the session on Auto for an unpinned thread", async () => {
    const sessions = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-auto", { models: MOCK_MODEL_OPTION });
    const session = createProjectChatSession(
      { threadId },
      { threads, cwd: repoPath },
    );

    await openChat(session, { spawn: () => process, sessions });

    expect(process.modelRequests()).toEqual([]);
  });

  it("persists transcript via ChatThreadStore and auto-titles on turn complete", () => {
    const session = createProjectChatSession(
      { threadId },
      { threads, cwd: repoPath },
    );
    const messages = [
      {
        id: "u1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Explain the warm pool" }],
      },
    ];
    session.saveTranscript(messages);
    expect(threads.loadTranscript(threadId)).toEqual(messages);
    expect(threads.getThread(threadId)?.title).toBe("New Chat");

    session.onTurnComplete?.();
    expect(threads.getThread(threadId)?.title).toBe("Explain the warm pool");
  });

  it("notifies onBranchableUpdated after each transcript save", () => {
    const updates: Array<{ headId: string | null; count: number }> = [];
    const session = createProjectChatSession(
      { threadId },
      {
        threads,
        cwd: repoPath,
        onBranchableUpdated: (branchable) => {
          updates.push({
            headId: branchable.headId,
            count: branchable.messages.length,
          });
        },
      },
    );

    session.saveTranscript([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      },
    ]);
    expect(updates).toEqual([{ headId: "u1", count: 1 }]);

    // Truncate then append — second save forks a sibling; callback must fire
    // so the WS client can show the branch picker without remounting.
    threads.truncateTranscript(threadId, null);
    session.saveTranscript([
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "edited" }],
      },
    ]);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({ headId: "u2", count: 2 });
    expect(threads.getBranches(threadId, "u2").sort()).toEqual(["u1", "u2"]);
  });

  it("rejects missing threads at the factory", () => {
    expect(() =>
      createProjectChatSession(
        { threadId: "missing" },
        { threads, cwd: repoPath },
      ),
    ).toThrow(/thread not found/i);
  });

  it("opens warm ACP without an opening monologue", async () => {
    const sessions = new ChatSessionRegistry();
    const process = new MockAcpProcess();
    process.autoHandshake("sess-project");
    const session = createProjectChatSession(
      { threadId },
      { threads, cwd: repoPath },
    );

    await openChat(session, { spawn: () => process, sessions });
    await new Promise((r) => setTimeout(r, 30));
    expect(process.prompts()).toHaveLength(0);
    expect(sessions.hasWarm(`thread:${threadId}`)).toBe(true);
  });
});
