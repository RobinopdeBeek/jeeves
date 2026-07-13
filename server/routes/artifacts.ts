import { Hono } from "hono";
import { artifactKinds, type ArtifactKind } from "../db/schema.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { StepKey } from "../pipelines.js";

function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (artifactKinds as readonly string[]).includes(value);
}

/** Latest artifact content for a card step — read-only UI surface. */
export function artifactRoutes(artifacts: ArtifactStore) {
  const app = new Hono();

  app.get("/latest", (c) => {
    const cardId = c.req.param("id");
    const stepKey = c.req.query("stepKey") as StepKey | undefined;
    const kind = c.req.query("kind");
    const round = Number(c.req.query("round") ?? "0");

    if (!stepKey || !isArtifactKind(kind) || Number.isNaN(round)) {
      return c.json({ error: "stepKey, kind, and round are required" }, 400);
    }

    const artifact = artifacts.latest(cardId, { stepKey, round, kind });
    if (!artifact) return c.json({ error: "not found" }, 404);

    return c.json({
      id: artifact.id,
      cardId: artifact.cardId,
      stepKey: artifact.stepKey,
      round: artifact.round,
      kind: artifact.kind,
      gitSha: artifact.gitSha,
      createdAt: artifact.createdAt.toISOString(),
      content: artifacts.readBody(artifact),
    });
  });

  return app;
}
