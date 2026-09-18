import { useQuery } from "@tanstack/react-query";
import { Briefcase, Inbox, LogOut, MessageCircle, Moon, Search, Settings, Sparkles, Sun, Tags as TagsIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { authClient } from "@/lib/auth-client";
import { documentsApi } from "@/lib/documents-api";
import { categoriesApi, tagsApi, type CategoryRow, type TagRow } from "@/lib/tags-api";

// Two-level navigation: a thin icon rail selects a section, a context panel next to
// it shows that section's links. Pattern similar to editors like VS Code that pair an
// activity bar with a contextual side panel.

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

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="h-5 w-5" />;
  const isDark = resolvedTheme === "dark";
  return (
    <button
      type="button"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-xl p-2 text-org-neutral-600 hover:text-foreground"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}

function IconRail({ activeTab }: { activeTab: RailTab }) {
  return (
    <aside className="flex w-[60px] shrink-0 flex-col items-center gap-1 bg-card py-4">
      <span className="mb-4 h-[26px] w-[26px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <nav className="flex flex-col items-center gap-1">
        {railItems.map(({ tab, label, to, icon: Icon }) => (
          <NavLink
            key={tab}
            to={to}
            title={label}
            className={`rounded-xl p-2 ${
              activeTab === tab ? "bg-primary text-primary-foreground" : "text-org-neutral-600 hover:text-foreground"
            }`}
          >
            <Icon className="h-5 w-5" />
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
  return (
    <>
      <span className="font-heading text-lg">Search</span>
      <nav className="flex flex-col gap-1">
        <NavLink to="/search" className={navPillClass}>
          Search documents
        </NavLink>
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

function JobsPanel() {
  return (
    <>
      <span className="font-heading text-lg">Jobs</span>
      <nav className="flex flex-col gap-1">
        <NavLink to="/jobs" className={navPillClass}>
          Background jobs
        </NavLink>
      </nav>
    </>
  );
}

export function AppShell() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<RailTab>(() => tabForPath(location.pathname));

  useEffect(() => {
    setActiveTab(tabForPath(location.pathname));
  }, [location.pathname]);

  const { data: counts = { inbox: 0, needsReview: 0, trash: 0 } } = useQuery({ queryKey: ["documents", "counts"], queryFn: () => documentsApi.counts() });
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });

  return (
    <div className="flex min-h-screen">
      <IconRail activeTab={activeTab} />
      <aside className="flex w-[220px] shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-card p-6">
        {activeTab === "files" && <FilesPanel inboxCount={counts.inbox} needsReviewCount={counts.needsReview} trashCount={counts.trash} />}
        {activeTab === "search" && <SearchPanel />}
        {activeTab === "tags" && <TagsPanel tags={tags} categories={categories} />}
        {activeTab === "sorting" && <SortingPanel automaticCount={countAutomaticItems(tags, categories)} />}
        {activeTab === "chat" && <ChatPanel />}
        {activeTab === "settings" && <SettingsPanel />}
        {activeTab === "jobs" && <JobsPanel />}
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
