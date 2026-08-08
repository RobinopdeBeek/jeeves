import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import type { Project } from "../db/schema.js";
import { CardDiffService } from "../execution/card-diff.js";
import { EventBus } from "../execution/events.js";
import { ChatSessionRegistry } from "../ws/session-registry.js";
import { cardRoutes, type CardRouteDeps } from "./cards.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  return stdout;
}

describe("GET /:id/diff", { timeout: 30_000 }, () => {
  let db: Db;
  let store: CardStore;
  let project: Project;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let repoPath: string;
  let deps: CardRouteDeps;

  beforeEach(async () => {
    db = openDb(":memory:");
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-diff-art-"));
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-diff-repo-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    store = new CardStore(db, artifacts);
    project = store.ensureDefaultProject("jeeves", repoPath);

    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test"]);
    await git(repoPath, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoPath, "a.txt"), "one\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);

    deps = {
      engine: {
        enqueue() {},
        retry() {
          throw new Error("unused");
        },
      } as unknown as CardRouteDeps["engine"],
      runs: { listForCard: () => [] } as unknown as CardRouteDeps["runs"],
      events: new EventBus(),
      artifacts,
      cardAttachments: {} as CardRouteDeps["cardAttachments"],
      sessions: new ChatSessionRegistry(),
      spawn: vi.fn() as unknown as CardRouteDeps["spawn"],
      createSpec: vi.fn(async () => {
        throw new Error("unused");
      }),
      createTasks: vi.fn(async () => {
        throw new Error("unused");
      }),
      promptsRoot: path.resolve(import.meta.dirname, "../../prompts"),
      cardDiff: new CardDiffService(repoPath),
    };
  }, 30_000);

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns file list, stats, and resolved base/tip SHAs for upstream...cardBranch", async () => {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Task" });
    const decided = store.decideKind(card.id, "standalone").card;
    const branch = `jeeves/card-${decided.id}`;
    await git(repoPath, ["checkout", "-b", branch]);
    fs.writeFileSync(path.join(repoPath, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repoPath, "b.txt"), "new\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "impl"]);
    const tipSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    const baseSha = (await git(repoPath, ["rev-parse", "main"])).trim();
    store.setCardBranch(decided.id, branch);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${decided.id}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upstreamRef: string;
      cardBranch: string;
      baseSha: string;
      tipSha: string;
      files: Array<{ path: string; status: string; additions: number; deletions: number }>;
      totalAdditions: number;
      totalDeletions: number;
    };
    expect(body.upstreamRef).toBe("main");
    expect(body.cardBranch).toBe(branch);
    expect(body.baseSha).toBe(baseSha);
    expect(body.tipSha).toBe(tipSha);
    expect(body.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "a.txt", status: "modified" }),
        expect.objectContaining({ path: "b.txt", status: "added", additions: 1 }),
      ]),
    );
    expect(body.totalAdditions).toBeGreaterThan(0);
  });

  it("fetches a per-file unified patch lazily", async () => {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Task" });
    const decided = store.decideKind(card.id, "standalone").card;
    const branch = `jeeves/card-${decided.id}`;
    await git(repoPath, ["checkout", "-b", branch]);
    fs.writeFileSync(path.join(repoPath, "a.txt"), "changed\n");
    await git(repoPath, ["add", "a.txt"]);
    await git(repoPath, ["commit", "-m", "change"]);
    store.setCardBranch(decided.id, branch);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(
      `http://localhost/${decided.id}/diff/file?path=${encodeURIComponent("a.txt")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; patch: string };
    expect(body.path).toBe("a.txt");
    expect(body.patch).toContain("diff --git");
    expect(body.patch).toContain("-one");
    expect(body.patch).toContain("+changed");
  });

  it("uses the parent feature branch as upstream for child tasks", async () => {
    const feature = store.createCard(project.id);
    store.updateCard(feature.id, { title: "Feature" });
    const featureId = store.decideKind(feature.id, "feature").card.id;
    store.handOffGrillToSpec(featureId);
    artifacts.upsertSpec(featureId, 0, "# Spec\n\nBody.\n");
    store.handOffSpecToTasks(featureId);
    artifacts.appendTasksDraft(featureId, 0, {
      tasks: [{ id: "t1", title: "Child slice", description: "", dependsOn: [] }],
    });
    await git(repoPath, ["branch", "jeeves/card-feature", "main"]);
    store.setCardBranch(featureId, "jeeves/card-feature");
    await git(repoPath, ["checkout", "jeeves/card-feature"]);
    fs.writeFileSync(path.join(repoPath, "feature-only.txt"), "feat\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "feature base"]);
    const featureTip = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

    const { children } = store.fanOut(featureId);
    const child = children[0]!;
    const childBranch = `jeeves/card-${child.id}`;
    await git(repoPath, ["checkout", "-b", childBranch]);
    fs.writeFileSync(path.join(repoPath, "child.txt"), "child\n");
    await git(repoPath, ["add", "child.txt"]);
    await git(repoPath, ["commit", "-m", "child work"]);
    store.setCardBranch(child.id, childBranch);

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${child.id}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upstreamRef: string;
      baseSha: string;
      files: Array<{ path: string }>;
    };
    expect(body.upstreamRef).toBe("jeeves/card-feature");
    expect(body.baseSha).toBe(featureTip);
    expect(body.files.map((f) => f.path)).toEqual(["child.txt"]);
    expect(body.files.map((f) => f.path)).not.toContain("feature-only.txt");
  });

  it("returns 409 when the card branch is missing", async () => {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Task" });
    const decided = store.decideKind(card.id, "standalone").card;

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${decided.id}/diff`);
    expect(res.status).toBe(409);
  });

  it("returns 400 when file path is missing", async () => {
    const card = store.createCard(project.id);
    store.updateCard(card.id, { title: "Task" });
    const decided = store.decideKind(card.id, "standalone").card;
    store.setCardBranch(decided.id, "jeeves/card-x");

    const app = cardRoutes(store, project, deps);
    const res = await app.request(`http://localhost/${decided.id}/diff/file`);
    expect(res.status).toBe(400);
  });
});
