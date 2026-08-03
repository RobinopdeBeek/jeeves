import { describe, expect, it } from "vitest";
import {
  APP_SHELL_TABS,
  ROOT_REDIRECT_TO,
  isAppShellPath,
  resolveAppShellTab,
} from "./app-routes";

describe("app-routes", () => {
  it("redirects / to /board", () => {
    expect(ROOT_REDIRECT_TO).toBe("/board");
  });

  it("lists Board, Chat, and Files as shell tabs", () => {
    expect(APP_SHELL_TABS.map((t) => t.id)).toEqual(["board", "chat", "files"]);
    expect(APP_SHELL_TABS.map((t) => t.path)).toEqual(["/board", "/chat", "/files"]);
  });

  it("treats shell surfaces as in-shell and /cards/:id as outside", () => {
    expect(isAppShellPath("/board")).toBe(true);
    expect(isAppShellPath("/chat")).toBe(true);
    expect(isAppShellPath("/files")).toBe(true);
    expect(isAppShellPath("/cards/abc")).toBe(false);
    expect(isAppShellPath("/")).toBe(false);
  });

  it("resolves the active shell tab from the pathname", () => {
    expect(resolveAppShellTab("/board")).toBe("board");
    expect(resolveAppShellTab("/chat")).toBe("chat");
    expect(resolveAppShellTab("/chat/thread-1")).toBe("chat");
    expect(resolveAppShellTab("/files")).toBe("files");
    expect(resolveAppShellTab("/cards/abc")).toBeNull();
  });
});
