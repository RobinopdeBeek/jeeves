import { useNavigate, useLocation, Link, Outlet } from "react-router-dom";
import { APP_SHELL_TABS, resolveAppShellTab } from "@/lib/app-routes";
import { BrandTitle } from "@/components/BrandTitle";
import { Logo } from "@/components/Logo";
import { ProjectChrome } from "@/components/ProjectChrome";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function ShellTabToggle({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = resolveAppShellTab(pathname) ?? "board";

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={active}
      onValueChange={(value) => {
        if (!value) return;
        const tab = APP_SHELL_TABS.find((t) => t.id === value);
        if (tab) navigate(tab.path);
      }}
      className={className}
      aria-label="App sections"
    >
      {APP_SHELL_TABS.map((tab) => (
        <ToggleGroupItem key={tab.id} value={tab.id} className="flex-1 px-4">
          {tab.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function AppShell() {
  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-4 py-2.5">
        <Link to="/board" className="flex items-center gap-3 justify-self-start">
          <Logo className="size-12" />
          <BrandTitle />
        </Link>
        <ShellTabToggle className="hidden md:flex" />
        <div className="justify-self-end">
          <ProjectChrome />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>

      <nav className="flex shrink-0 justify-stretch border-t p-1 md:hidden">
        <ShellTabToggle className="flex w-full" />
      </nav>
    </div>
  );
}
