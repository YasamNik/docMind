import { randomBytes } from "node:crypto";

export function newTagId() {
  return `tag_${randomBytes(8).toString("hex")}`;
}

export function newCategoryId() {
  return `cat_${randomBytes(8).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeName(name: string): string {
  return name.trim();
}

export type CategoryNode = { id: string; parentId: string | null; name: string };

export function buildCategoryPaths(categories: CategoryNode[], separator = " / "): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const paths = new Map<string, string>();

  function pathFor(id: string, seen: Set<string>): string {
    if (paths.has(id)) return paths.get(id)!;
    const node = byId.get(id);
    if (!node) return "";
    if (seen.has(id)) return node.name;
    seen.add(id);
    const parentPath = node.parentId ? pathFor(node.parentId, seen) : "";
    const full = parentPath ? `${parentPath}${separator}${node.name}` : node.name;
    paths.set(id, full);
    return full;
  }

  for (const c of categories) pathFor(c.id, new Set());
  return paths;
}

// Assumes the parentId links form a tree with no cycles (wouldCreateCycle enforces
// this at write time). There is no visited-set guard here, so a cycle in the data
// would make this loop forever instead of just returning a wrong answer.
export function collectDescendantIds(categories: CategoryNode[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c.id);
    childrenByParent.set(c.parentId, list);
  }
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenByParent.get(current) ?? []) {
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}

export function wouldCreateCycle(categories: CategoryNode[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  const descendants = new Set(collectDescendantIds(categories, id));
  return descendants.has(newParentId);
}

export function nextSortOrder(siblingSortOrders: number[]): number {
  return siblingSortOrders.length === 0 ? 0 : Math.max(...siblingSortOrders) + 1;
}

export function sortByNameCI<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function sortCategories<T extends { name: string; sortOrder: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
