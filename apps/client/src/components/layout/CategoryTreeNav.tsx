import { NavLink } from "react-router-dom";
import type { CategoryRow } from "@/lib/tags-api";

function childrenOf(categories: CategoryRow[], parentId: string | null): CategoryRow[] {
  return categories.filter((c) => c.parentId === parentId);
}

/** Computes the recursive count for each category: its own documentCount plus all descendants'. */
function recursiveCounts(categories: CategoryRow[]): Map<string, number> {
  const childrenMap = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    const list = childrenMap.get(c.parentId) ?? [];
    list.push(c.id);
    childrenMap.set(c.parentId, list);
  }
  const byId = new Map(categories.map((c) => [c.id, c]));
  const cache = new Map<string, number>();
  function total(id: string): number {
    if (cache.has(id)) return cache.get(id)!;
    const node = byId.get(id);
    if (!node) return 0;
    let sum = node.documentCount;
    for (const childId of childrenMap.get(id) ?? []) sum += total(childId);
    cache.set(id, sum);
    return sum;
  }
  for (const c of categories) total(c.id);
  return cache;
}

function CategoryNode({
  category,
  categories,
  depth,
  counts,
}: {
  category: CategoryRow;
  categories: CategoryRow[];
  depth: number;
  counts: Map<string, number>;
}) {
  const children = childrenOf(categories, category.id);
  const count = counts.get(category.id) ?? category.documentCount;
  return (
    <div>
      <NavLink
        to={`/documents?categoryId=${category.id}`}
        className={({ isActive }) =>
          `flex items-center justify-between gap-2 rounded-full px-3 py-1.5 text-sm ${
            isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-foreground/5"
          }`
        }
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        {({ isActive }) => (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${category.color ? "" : "bg-org-neutral-400"}`}
                style={category.color ? { backgroundColor: category.color } : undefined}
              />
              <span className="truncate">{category.name}</span>
            </span>
            {count > 0 && (
              <span className={`text-xs ${isActive ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{count}</span>
            )}
          </>
        )}
      </NavLink>
      {children.map((child) => (
        <CategoryNode key={child.id} category={child} categories={categories} depth={depth + 1} counts={counts} />
      ))}
    </div>
  );
}

export function CategoryTreeNav({ categories }: { categories: CategoryRow[] }) {
  const roots = childrenOf(categories, null);
  if (roots.length === 0) return <p className="px-3 text-xs text-muted-foreground">No categories yet.</p>;
  const counts = recursiveCounts(categories);
  return (
    <nav className="flex flex-col gap-0.5">
      {roots.map((c) => (
        <CategoryNode key={c.id} category={c} categories={categories} depth={0} counts={counts} />
      ))}
    </nav>
  );
}
