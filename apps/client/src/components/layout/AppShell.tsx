import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { documentsApi } from "@/lib/documents-api";
import { categoriesApi, tagsApi } from "@/lib/tags-api";
import { CategoryTreeNav } from "./CategoryTreeNav";

const bottomLinks = [
  { to: "/rules", label: "Rules" },
  { to: "/jobs", label: "Jobs" },
  { to: "/settings", label: "Settings" },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `rounded px-3 py-2 text-sm ${isActive ? "bg-muted font-medium" : "hover:bg-muted"}`;
}

function CountRow({ to, label, count }: { to: string; label: string; count: number }) {
  return (
    <NavLink to={to} className="flex items-center justify-between rounded px-3 py-2 text-sm hover:bg-muted">
      <span>{label}</span>
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
      <aside className="w-64 shrink-0 border-r p-4 flex flex-col gap-4 overflow-y-auto">
        <div className="text-lg font-semibold">DocMind</div>

        <nav className="flex flex-col gap-1">
          <NavLink to="/documents" end className={navLinkClass}>
            All documents
          </NavLink>
          <CountRow to="/documents?view=inbox" label="Inbox" count={inbox.length} />
          <CountRow to="/documents?view=needs_review" label="Needs review" count={needsReview.length} />
        </nav>

        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">Categories</span>
            <NavLink to="/categories" className="text-xs underline-offset-2 hover:underline">
              Manage
            </NavLink>
          </div>
          <CategoryTreeNav categories={categories} />
        </div>

        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">Tags</span>
            <NavLink to="/tags" className="text-xs underline-offset-2 hover:underline">
              Manage
            </NavLink>
          </div>
          {tags.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">No tags yet.</p>
          ) : (
            <nav className="flex flex-col gap-0.5">
              {tags.map((t) => (
                <CountRow key={t.id} to={`/documents?tagId=${t.id}`} label={t.name} count={t.documentCount} />
              ))}
            </nav>
          )}
        </div>

        <nav className="flex flex-col gap-1 mt-auto pt-4 border-t">
          {bottomLinks.map((l) => (
            <NavLink key={l.to} to={l.to} className={navLinkClass}>
              {l.label}
            </NavLink>
          ))}
          <Button variant="ghost" className="w-full justify-start" onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}>
            Sign out
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
