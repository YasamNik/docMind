import { useQuery } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Briefcase, Inbox, LogOut, Menu, MessageCircle, Moon, Search, Settings, Sparkles, Sun, Tags as TagsIcon, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { authClient } from "@/lib/auth-client";
import { documentsApi } from "@/lib/documents-api";
import { jobsApi } from "@/lib/jobs-api";
import { savedSearchesApi } from "@/lib/saved-searches-api";
import { useKeyboardShortcuts } from "@/lib/use-keyboard-shortcuts";
import { categoriesApi, tagsApi, type CategoryRow, type TagRow } from "@/lib/tags-api";
import { useIsMobile } from "@/lib/use-media-query";

// Two-level navigation: a thin icon rail selects a section, a context panel next to
// it shows that section's links. Pattern similar to editors like VS Code that pair an
// activity bar with a contextual side panel.
//
// Below the md breakpoint the rail and panel give way to a sticky top bar and a slide-over
// drawer holding both levels, the same shape shadcn's sidebar block uses to collapse a rail
// into a sheet on a phone.

type RailTab = "files" | "search" | "tags" | "sorting" | "chat" | "settings" | "jobs";

const railItems: { tab: RailTab; label: string; to: string; icon: LucideIcon }[] = [
  { tab: "files", label: "Files", to: "/inbox", icon: Inbox },
  { tab: "search", label: "Search", to: "/search", icon: Search },
  { tab: "tags", label: "Tags", to: "/tags", icon: TagsIcon },
  { tab: "sorting", label: "Sorting", to: "/sorting", icon: Sparkles },
  { tab: "chat", label: "Chat", to: "/chat", icon: MessageCircle },
  { tab: "settings", label: "Settings", to: "/settings", icon: Settings },
  { tab: "jobs", label: "Jobs", to: "/jobs", icon: Briefcase },
];

function tabForPath(pathname: string): RailTab {
  if (pathname.startsWith("/search")) return "search";
  if (pathname.startsWith("/tags") || pathname.startsWith("/categories")) return "tags";
  if (pathname.startsWith("/sorting")) return "sorting";
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/jobs")) return "jobs";
  if (pathname.startsWith("/inbox") || pathname.startsWith("/documents")) return "files";
  return "files";
}

function countAutomaticItems(tags: TagRow[], categories: CategoryRow[]): number {
  const autoTags = tags.filter((t) => t.autoApply && t.description.trim() !== "").length;
  const autoCategories = categories.filter((c) => c.autoApply && c.description.trim() !== "").length;
  return autoTags + autoCategories;
}

function navPillClass({ isActive }: { isActive: boolean }) {
  return `rounded-full px-3 py-2 text-sm ${isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-foreground/5"}`;
}

function CountRow({ to, label, count, color }: { to: string; label: string; count: number; color?: string | null }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center justify-between gap-2 rounded-full px-3 py-2 text-sm ${
          isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-foreground/5"
        }`
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        {color !== undefined && (
          <span
            className={`h-[7px] w-[7px] shrink-0 rounded-full ${color ? "" : "bg-org-neutral-400"}`}
            style={color ? { backgroundColor: color } : undefined}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      {count > 0 && <Badge variant="secondary">{count}</Badge>}
    </NavLink>
  );
}

function ThemeToggle({ size = "sm" }: { size?: "sm" | "lg" }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const buttonClass =
    size === "lg"
      ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-org-neutral-600 hover:text-foreground"
      : "rounded-xl p-2 text-org-neutral-600 hover:text-foreground";
  if (!mounted) return <span className="h-5 w-5" />;
  const isDark = resolvedTheme === "dark";
  return (
    <button
      type="button"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={buttonClass}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}

function IconRail({ activeTab, failedJobCount }: { activeTab: RailTab; failedJobCount: number }) {
  return (
    <aside className="flex w-[60px] shrink-0 flex-col items-center gap-1 bg-card py-4">
      <span className="mb-4 h-[26px] w-[26px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <nav className="flex flex-col items-center gap-1">
        {railItems.map(({ tab, label, to, icon: Icon }) => (
          <NavLink
            key={tab}
            to={to}
            title={label}
            className={`relative rounded-xl p-2 ${
              activeTab === tab ? "bg-primary text-primary-foreground" : "text-org-neutral-600 hover:text-foreground"
            }`}
          >
            <Icon className="h-5 w-5" />
            {tab === "jobs" && failedJobCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-destructive" />
            )}
            <span className="sr-only">{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          title="Sign out"
          className="rounded-xl p-2 text-org-neutral-600 hover:text-foreground"
          onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}
        >
          <LogOut className="h-5 w-5" />
          <span className="sr-only">Sign out</span>
        </button>
      </div>
    </aside>
  );
}

function FilesPanel({ inboxCount, needsReviewCount, trashCount }: { inboxCount: number; needsReviewCount: number; trashCount: number }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-heading text-lg">DocMind</span>
      </div>

      <nav className="flex flex-col gap-1">
        <CountRow to="/inbox" label="Inbox" count={inboxCount} />
        <NavLink to="/documents" end className={navPillClass}>
          All documents
        </NavLink>
        <CountRow to="/documents?view=needs_review" label="Needs review" count={needsReviewCount} />
        <CountRow to="/documents?view=trash" label="Trash" count={trashCount} />
      </nav>

      <div className="mt-auto flex flex-col gap-1 px-3">
        <NavLink to="/categories" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          Manage categories
        </NavLink>
        <NavLink to="/tags" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          Manage tags
        </NavLink>
      </div>
    </>
  );
}

function SearchPanel() {
  const { data: saved = [] } = useQuery({ queryKey: ["saved-searches"], queryFn: savedSearchesApi.list });
  return (
    <>
      <span className="font-heading text-lg">Search</span>
      <nav className="flex flex-col gap-1">
        <NavLink to="/search" className={navPillClass}>
          Search documents
        </NavLink>
        {saved.map((s) => (
          <NavLink key={s.id} to={`/search?saved=${s.id}`} className={navPillClass}>
            {s.name}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

function TagsPanel({ tags, categories }: { tags: TagRow[]; categories: CategoryRow[] }) {
  return (
    <>
      <span className="font-heading text-lg">Tags</span>
      <nav className="flex flex-col gap-1">
        <CountRow to="/tags" label="Manage tags" count={tags.length} />
        <CountRow to="/categories" label="Manage categories" count={categories.length} />
      </nav>
    </>
  );
}

function ChatPanel() {
  return (
    <>
      <span className="font-heading text-lg">Chat</span>
      <nav className="flex flex-col gap-1">
        <NavLink to="/chat" className={navPillClass}>
          Chat with your documents
        </NavLink>
      </nav>
    </>
  );
}

function SortingPanel({ automaticCount }: { automaticCount: number }) {
  return (
    <>
      <span className="font-heading text-lg">Sorting</span>
      <nav className="flex flex-col gap-1">
        <CountRow to="/sorting" label="Automatic rules" count={automaticCount} />
      </nav>
    </>
  );
}

function SettingsPanel() {
  return (
    <>
      <span className="font-heading text-lg">Settings</span>
      <nav className="flex flex-col gap-1">
        <NavLink to="/settings" className={navPillClass}>
          General settings
        </NavLink>
      </nav>
    </>
  );
}

function JobsPanel({ failedCount }: { failedCount: number }) {
  return (
    <>
      <span className="font-heading text-lg">Jobs</span>
      <nav className="flex flex-col gap-1">
        <NavLink to="/jobs" className={navPillClass}>
          Background jobs
        </NavLink>
        {failedCount > 0 && (
          <CountRow to="/jobs" label="Failed" count={failedCount} />
        )}
      </nav>
    </>
  );
}

// The context panel's content depends only on the active section, so both the desktop
// aside and the mobile drawer render it from this one place.
function ContextPanelContent({
  activeTab,
  inboxCount,
  needsReviewCount,
  trashCount,
  tags,
  categories,
  failedJobCount,
}: {
  activeTab: RailTab;
  inboxCount: number;
  needsReviewCount: number;
  trashCount: number;
  tags: TagRow[];
  categories: CategoryRow[];
  failedJobCount: number;
}) {
  if (activeTab === "files") return <FilesPanel inboxCount={inboxCount} needsReviewCount={needsReviewCount} trashCount={trashCount} />;
  if (activeTab === "search") return <SearchPanel />;
  if (activeTab === "tags") return <TagsPanel tags={tags} categories={categories} />;
  if (activeTab === "sorting") return <SortingPanel automaticCount={countAutomaticItems(tags, categories)} />;
  if (activeTab === "chat") return <ChatPanel />;
  if (activeTab === "settings") return <SettingsPanel />;
  if (activeTab === "jobs") return <JobsPanel failedCount={failedJobCount} />;
  return null;
}

function MobileTopBar({
  label,
  failedJobCount,
  unreadCount,
  onOpenMenu,
}: {
  label: string;
  failedJobCount: number;
  unreadCount: number;
  onOpenMenu: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-card px-2 py-1">
      <button
        type="button"
        aria-label="Open navigation menu"
        onClick={onOpenMenu}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-org-neutral-600 hover:text-foreground"
      >
        <Menu className="h-5 w-5" />
      </button>
      <span className="font-heading text-lg">{label}</span>
      <div className="flex items-center gap-1.5">
        {failedJobCount > 0 && (
          <Badge variant="destructive" aria-label="Failed jobs">
            {failedJobCount}
          </Badge>
        )}
        {unreadCount > 0 && (
          <Badge variant="secondary" aria-label="Items needing attention">
            {unreadCount}
          </Badge>
        )}
      </div>
      <div className="ml-auto flex items-center">
        <ThemeToggle size="lg" />
      </div>
    </header>
  );
}

function NavDrawer({
  open,
  onOpenChange,
  activeTab,
  failedJobCount,
  panel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: RailTab;
  failedJobCount: number;
  panel: ReactNode;
}) {
  // Any nav link inside the drawer closes it once chosen. A click elsewhere in the same
  // area (empty padding, the section heading) does nothing, since it did not choose a
  // destination.
  function closeIfLinkClicked(event: React.MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("a")) onOpenChange(false);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-org-neutral-900/50 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          aria-label="Navigation"
          className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col gap-6 overflow-y-auto bg-card p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none duration-150 data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
        >
          <div className="flex items-center justify-between">
            <span className="font-heading text-lg">DocMind</span>
            <DialogPrimitive.Close
              aria-label="Close navigation"
              className="flex h-11 w-11 items-center justify-center rounded-xl text-org-neutral-600 hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          <nav className="flex flex-col gap-1" onClick={closeIfLinkClicked}>
            {railItems.map(({ tab, label, to, icon: Icon }) => (
              <NavLink
                key={tab}
                to={to}
                className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-3 text-sm ${
                  activeTab === tab ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-foreground/5"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span>{label}</span>
                {tab === "jobs" && failedJobCount > 0 && (
                  <Badge variant="destructive" className="ml-auto" aria-label="Failed jobs">
                    {failedJobCount}
                  </Badge>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex flex-col gap-6 border-t border-border pt-6 [&_a]:py-3" onClick={closeIfLinkClicked}>
            {panel}
          </div>

          <button
            type="button"
            className="mt-auto flex min-h-11 items-center gap-2 rounded-xl px-3 py-3 text-sm text-org-neutral-600 hover:text-foreground"
            onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}
          >
            <LogOut className="h-5 w-5" />
            <span>Sign out</span>
          </button>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function AppShell() {
  useKeyboardShortcuts();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<RailTab>(() => tabForPath(location.pathname));
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isMobileLayout = useIsMobile();

  useEffect(() => {
    setActiveTab(tabForPath(location.pathname));
    setIsMenuOpen(false);
  }, [location.pathname]);

  const { data: counts = { inbox: 0, needsReview: 0, trash: 0 } } = useQuery({ queryKey: ["documents", "counts"], queryFn: () => documentsApi.counts() });
  const { data: jobCounts = { failed: 0 } } = useQuery({ queryKey: ["jobs", "counts"], queryFn: () => jobsApi.counts(), refetchInterval: 15000 });
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });

  const failedJobCount = jobCounts.failed;
  const unreadCount = counts.inbox + counts.needsReview;
  const activeLabel = railItems.find((item) => item.tab === activeTab)?.label ?? "";

  const panel = (
    <ContextPanelContent
      activeTab={activeTab}
      inboxCount={counts.inbox}
      needsReviewCount={counts.needsReview}
      trashCount={counts.trash}
      tags={tags}
      categories={categories}
      failedJobCount={failedJobCount}
    />
  );

  if (isMobileLayout) {
    return (
      <div className="flex min-h-screen flex-col">
        <MobileTopBar label={activeLabel} failedJobCount={failedJobCount} unreadCount={unreadCount} onOpenMenu={() => setIsMenuOpen(true)} />
        <NavDrawer open={isMenuOpen} onOpenChange={setIsMenuOpen} activeTab={activeTab} failedJobCount={failedJobCount} panel={panel} />
        <main className="flex-1 p-8">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <IconRail activeTab={activeTab} failedJobCount={failedJobCount} />
      <aside className="flex w-[220px] shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-card p-6">
        {panel}
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
