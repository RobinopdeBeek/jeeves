import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/store.js";
import { CardStore } from "../cards/store.js";
import { openDb, type Db } from "../db/index.js";
import { artifactRoutes } from "./artifacts.js";

describe("artifactRoutes", () => {
  let db: Db;
  let store: CardStore;
  let artifactRoot: string;
  let artifacts: ArtifactStore;
  let cardId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    store = new CardStore(db);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jeeves-artifact-routes-"));
    artifacts = new ArtifactStore(db, artifactRoot);
    const projectId = store.ensureDefaultProject("jeeves", "C:/target-repo").id;
    cardId = store.createCard(projectId).id;
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("returns the latest artifact body without YAML frontmatter", async () => {
    artifacts.save({
      cardId,
      stepKey: "plan",
      round: 0,
      kind: "plan",
      content: "# Plan\n\nShip it.",
      sourceSkill: "slice-3-tracer",
    });

    const app = new Hono();
    app.route("/:id/artifacts", artifactRoutes(artifacts));
    const res = await app.request(
      `http://localhost/${cardId}/artifacts/latest?stepKey=plan&round=0&kind=plan`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; kind: string };
    expect(body.kind).toBe("plan");
    expect(body.content).toBe("# Plan\n\nShip it.");
    expect(body.content).not.toContain("card_id:");
  });

  it("returns 404 when no artifact matches", async () => {
    const app = new Hono();
    app.route("/:id/artifacts", artifactRoutes(artifacts));
    const res = await app.request(
      `http://localhost/${cardId}/artifacts/latest?stepKey=plan&round=0&kind=runlog`,
      { method: "GET" },
    );
    expect(res.status).toBe(404);
  });
});
