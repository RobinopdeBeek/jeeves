import { describe, expect, it } from "vitest";
import { modelRoutes } from "./models.js";

describe("model routes", () => {
  it("lists parsed models from the host wrapper", async () => {
    const app = modelRoutes(async () =>
      [
        "Available models",
        "",
        "composer-2.5 - Composer 2.5 (current, default)",
        "gpt-5.5 - GPT-5.5",
      ].join("\n"),
    );

    const res = await app.request("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          current: true,
          default: true,
        },
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          current: false,
          default: false,
        },
      ],
    });
  });

  it("returns 502 when the CLI wrapper fails", async () => {
    const app = modelRoutes(async () => {
      throw new Error("auth failed");
    });
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "auth failed" });
  });
});
