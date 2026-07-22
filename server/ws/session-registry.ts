import type { StepKey } from "../pipelines.js";

export interface SessionKey {
  cardId: string;
  stepKey: StepKey;
  round: number;
}

/** Minimal seam for last-connection-wins — ChatConnection implements this. */
export interface DisplaceableConnection {
  displace(reason: string): void;
}

export function sessionKeyString(key: SessionKey): string {
  return `${key.cardId}:${key.stepKey}:${key.round}`;
}

/**
 * One live writer per (card, step, round). A new claim displaces the previous
 * connection with an explicit reason the client can surface as a banner.
 */
export class ChatSessionRegistry {
  private readonly active = new Map<string, DisplaceableConnection>();

  get(key: SessionKey): DisplaceableConnection | undefined {
    return this.active.get(sessionKeyString(key));
  }

  claim(key: SessionKey, connection: DisplaceableConnection): void {
    const id = sessionKeyString(key);
    const previous = this.active.get(id);
    if (previous && previous !== connection) {
      previous.displace("session continued elsewhere");
    }
    this.active.set(id, connection);
  }

  release(key: SessionKey, connection: DisplaceableConnection): void {
    const id = sessionKeyString(key);
    if (this.active.get(id) === connection) {
      this.active.delete(id);
    }
  }

  /**
   * Tear down a live writer without a replacement (e.g. grill → spec hand-off).
   * Displaces the connection so the client sees a reason, then clears the slot.
   */
  close(key: SessionKey, reason: string): void {
    const id = sessionKeyString(key);
    const conn = this.active.get(id);
    if (!conn) return;
    conn.displace(reason);
    this.active.delete(id);
  }
}
