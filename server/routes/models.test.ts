import { describe, expect, it } from "vitest";
import { modelRoutes } from "./models.js";
import { ListModelsError } from "../models/list-models.js";

describe("model routes", () => {
  it("lists the models the agent offers", async () => {
    const app = modelRoutes(async () => [
      {
        id: "composer-2.5[fast=true]",
        displayName: "Composer 2.5 Fast",
        current: true,
        default: false,
      },
    ]);

    const res = await app.request("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        {
          id: "composer-2.5[fast=true]",
          displayName: "Composer 2.5 Fast",
          current: true,
          default: false,
        },
      ],
    });
  });

  it("returns 502 when no agent session has reported a catalog", async () => {
    const app = modelRoutes(async () => {
      throw new ListModelsError("no agent session has started yet");
    });
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "no agent session has started yet",
    });
  });
});
