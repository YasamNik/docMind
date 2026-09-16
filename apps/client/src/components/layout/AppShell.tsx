import { NavLink, Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const links = [
  { to: "/documents", label: "Documents" },
  { to: "/rules", label: "Rules" },
  { to: "/jobs", label: "Jobs" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r p-4 flex flex-col gap-2">
        <div className="text-lg font-semibold mb-4">DocMind</div>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) => `rounded px-3 py-2 text-sm ${isActive ? "bg-muted font-medium" : "hover:bg-muted"}`}
          >
            {l.label}
          </NavLink>
        ))}
        <div className="mt-auto">
          <Button variant="ghost" className="w-full" onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
