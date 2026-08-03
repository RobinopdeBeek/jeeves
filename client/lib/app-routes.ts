export type AppShellTabId = "board" | "chat" | "files";

export type AppShellTab = {
  id: AppShellTabId;
  path: `/${AppShellTabId}`;
  label: string;
};

/** Shared Board | Chat | Files destinations under the app shell. */
export const APP_SHELL_TABS: readonly AppShellTab[] = [
  { id: "board", path: "/board", label: "Board" },
  { id: "chat", path: "/chat", label: "Chat" },
  { id: "files", path: "/files", label: "Files" },
] as const;

/** `/` redirects here so the home URL stays stable as routes grow. */
export const ROOT_REDIRECT_TO = "/board" as const;

/** True for Board / Chat / Files (and nested paths under those prefixes). */
export function isAppShellPath(pathname: string): boolean {
  return resolveAppShellTab(pathname) !== null;
}

/** Active shell tab for `pathname`, or null when outside the tab shell (e.g. `/cards/:id`). */
export function resolveAppShellTab(pathname: string): AppShellTabId | null {
  for (const tab of APP_SHELL_TABS) {
    if (pathname === tab.path || pathname.startsWith(`${tab.path}/`)) {
      return tab.id;
    }
  }
  return null;
}
