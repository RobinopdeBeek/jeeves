import { describe, expect, it } from "vitest";
import { EventBus } from "../execution/events.js";
import { eventRoutes } from "./events.js";

describe("eventRoutes", () => {
  it("opens the SSE stream immediately with a ping", async () => {
    const response = await eventRoutes(new EventBus()).request("/");
    const reader = response.body!.getReader();

    const firstChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE stream did not open immediately")), 250),
      ),
    ]);
    await reader.cancel();

    expect(new TextDecoder().decode(firstChunk.value)).toContain("event: ping");
  });
});
