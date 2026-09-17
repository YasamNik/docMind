import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { documentsApi } from "@/lib/documents-api";
import { categoriesApi, tagsApi } from "@/lib/tags-api";
import { CategoryTreeNav } from "./CategoryTreeNav";

const bottomLinks = [
  { to: "/sorting", label: "Sorting" },
  { to: "/jobs", label: "Jobs" },
  { to: "/settings", label: "Settings" },
];

function navPillClass({ isActive }: { isActive: boolean }) {
  return `rounded-full px-3 py-2 text-sm ${isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-foreground/5"}`;
}

function sectionHeadingClass() {
  return "text-[10px] uppercase tracking-widest font-semibold text-org-neutral-700";
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

export function AppShell() {
  const { data: inbox = [] } = useQuery({ queryKey: ["documents", { view: "inbox" }], queryFn: () => documentsApi.list({ view: "inbox" }) });
  const { data: needsReview = [] } = useQuery({ queryKey: ["documents", { view: "needs_review" }], queryFn: () => documentsApi.list({ view: "needs_review" }) });
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 bg-card p-6 flex flex-col gap-6 overflow-y-auto">
        <div className="flex items-center gap-2">
          <span className="h-[26px] w-[26px] shrink-0 rounded-full bg-primary" />
          <span className="font-heading text-lg">DocMind</span>
        </div>

        <nav className="flex flex-col gap-1">
          <NavLink to="/documents" end className={navPillClass}>
            All documents
          </NavLink>
          <CountRow to="/documents?view=inbox" label="Inbox" count={inbox.length} />
          <CountRow to="/documents?view=needs_review" label="Needs review" count={needsReview.length} />
        </nav>

        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <span className={sectionHeadingClass()}>Categories</span>
            <NavLink to="/categories" className="text-xs underline-offset-2 hover:underline">
              Manage
            </NavLink>
          </div>
          <CategoryTreeNav categories={categories} />
        </div>

        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <span className={sectionHeadingClass()}>Tags</span>
            <NavLink to="/tags" className="text-xs underline-offset-2 hover:underline">
              Manage
            </NavLink>
          </div>
          {tags.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">No tags yet.</p>
          ) : (
            <nav className="flex flex-col gap-0.5">
              {tags.map((t) => (
                <CountRow key={t.id} to={`/documents?tagId=${t.id}`} label={t.name} count={t.documentCount} color={t.color} />
              ))}
            </nav>
          )}
        </div>

        <nav className="flex flex-col gap-1 mt-auto pt-4 border-t border-border">
          {bottomLinks.map((l) => (
            <NavLink key={l.to} to={l.to} className={navPillClass}>
              {l.label}
            </NavLink>
          ))}
          <Button variant="ghost" className="w-full justify-start" onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}>
            Sign out
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
