import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_MODEL_VALUE,
  ListModelsError,
  listAgentModels,
  modelsFromConfigOption,
  recordModelCatalog,
  resetModelCatalog,
  resolveModelValue,
} from "./list-models.js";
import type { AcpSessionConfigOption } from "../ws/chat.js";

const option: AcpSessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "composer-2.5[fast=true]",
  options: [
    { value: AUTO_MODEL_VALUE, name: "Auto" },
    { value: "composer-2.5[fast=true]", name: "Composer 2.5 Fast" },
    { value: "claude-opus-5[thinking=true,effort=high]", name: "Claude Opus 5" },
  ],
};

afterEach(() => {
  resetModelCatalog();
});

describe("modelsFromConfigOption", () => {
  it("maps config values to picker rows and drops Auto", () => {
    expect(modelsFromConfigOption(option)).toEqual([
      {
        id: "composer-2.5[fast=true]",
        displayName: "Composer 2.5 Fast",
        current: true,
        default: false,
      },
      {
        id: "claude-opus-5[thinking=true,effort=high]",
        displayName: "Claude Opus 5",
        current: false,
        default: false,
      },
    ]);
  });

  it("falls back to the bare id when the agent sends no display name", () => {
    const models = modelsFromConfigOption({
      ...option,
      options: [{ value: "gpt-5.5[effort=high]", name: "" }],
    });
    expect(models).toEqual([
      {
        id: "gpt-5.5[effort=high]",
        displayName: "gpt-5.5",
        current: false,
        default: false,
      },
    ]);
  });

  it("returns empty for a session with no model selector", () => {
    expect(modelsFromConfigOption(null)).toEqual([]);
  });
});

describe("resolveModelValue", () => {
  const values = (option.options ?? []).map((o) => o.value);

  it("passes through a value the account still offers", () => {
    expect(resolveModelValue("composer-2.5[fast=true]", values)).toBe(
      "composer-2.5[fast=true]",
    );
  });

  it("migrates a legacy bare id onto its variant string", () => {
    expect(resolveModelValue("composer-2.5", values)).toBe(
      "composer-2.5[fast=true]",
    );
  });

  it("falls back to Auto for an unknown or unpinned model", () => {
    expect(resolveModelValue("gpt-4", values)).toBe(AUTO_MODEL_VALUE);
    expect(resolveModelValue(null, values)).toBe(AUTO_MODEL_VALUE);
    expect(resolveModelValue("  ", values)).toBe(AUTO_MODEL_VALUE);
  });

  it("resolves to null when the session offers no Auto option", () => {
    expect(resolveModelValue("gpt-4", ["composer-2.5[fast=true]"])).toBeNull();
  });
});

describe("listAgentModels", () => {
  it("serves the catalog recorded by the first handshake", async () => {
    recordModelCatalog(option);
    await expect(listAgentModels()).resolves.toHaveLength(2);
  });

  it("ignores a handshake that carried no model options", async () => {
    recordModelCatalog(null);
    await expect(listAgentModels(10)).rejects.toBeInstanceOf(ListModelsError);
  });

  it("waits for a handshake that is still in flight", async () => {
    const pending = listAgentModels(1_000);
    recordModelCatalog(option);
    await expect(pending).resolves.toHaveLength(2);
  });

  it("fails when no session starts within the budget", async () => {
    await expect(listAgentModels(10)).rejects.toThrow(
      /no agent session has started/,
    );
  });
});
