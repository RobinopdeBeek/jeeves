import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import { runs, type Run } from "../db/schema.js";
import type { StepKey } from "../pipelines.js";

/**
 * Runs persistence — one immutable-ish row per skill invocation. Created
 * `running`, finished exactly once as `succeeded` or `failed`.
 */
export class RunStore {
  constructor(private readonly db: Db) {}

  create(input: {
    cardId: string;
    stepKey: StepKey;
    skill: string;
    logPath: string;
    round?: number;
    model?: string;
  }): Run {
    const run: Run = {
      id: nanoid(10),
      cardId: input.cardId,
      stepKey: input.stepKey,
      round: input.round ?? 0,
      skill: input.skill,
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      model: input.model ?? null,
      tokensIn: null,
      tokensOut: null,
      cost: null,
      error: null,
      logPath: input.logPath,
    };
    this.db.insert(runs).values(run).run();
    return run;
  }

  /** The log filename embeds the run id, so the path is set just after create. */
  setLogPath(id: string, logPath: string): void {
    this.db.update(runs).set({ logPath }).where(eq(runs.id, id)).run();
  }

  finish(
    id: string,
    outcome: {
      status: "succeeded" | "failed";
      error?: string;
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
    },
  ): void {
    this.db
      .update(runs)
      .set({
        status: outcome.status,
        finishedAt: new Date(),
        error: outcome.error ?? null,
        ...(outcome.model !== undefined && { model: outcome.model }),
        ...(outcome.tokensIn !== undefined && { tokensIn: outcome.tokensIn }),
        ...(outcome.tokensOut !== undefined && { tokensOut: outcome.tokensOut }),
      })
      .where(eq(runs.id, id))
      .run();
  }

  get(id: string): Run | undefined {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  /** All runs for a card, newest first. */
  listForCard(cardId: string): Run[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.cardId, cardId))
      .orderBy(desc(runs.startedAt))
      .all();
  }

  latestForStep(cardId: string, stepKey: StepKey): Run | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.stepKey, stepKey)))
      .orderBy(desc(runs.startedAt))
      .get();
  }

  /**
   * Boot-time orphan recovery: any run still `running` was interrupted by a
   * crash/restart. Mark it failed and report the affected steps so the
   * caller can move them to needs-user.
   */
  failOrphans(): Array<{ cardId: string; stepKey: StepKey }> {
    const orphans = this.db
      .select()
      .from(runs)
      .where(eq(runs.status, "running"))
      .all();
    for (const orphan of orphans) {
      this.finish(orphan.id, {
        status: "failed",
        error: "interrupted by server restart",
      });
    }
    return orphans.map((o) => ({
      cardId: o.cardId,
      stepKey: o.stepKey as StepKey,
    }));
  }
}
