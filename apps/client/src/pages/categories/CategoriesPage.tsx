import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DryRunPanel } from "@/components/sorting/DryRunPanel";
import { categoriesApi, type CategoryInput, type CategoryRow } from "@/lib/tags-api";

const emptyForm: CategoryInput = { name: "", parentId: null, color: "", description: "", confidenceThreshold: 0.7, autoApply: true };

function CategoryForm({
  initial,
  categories,
  excludeId,
  onSubmit,
  submitting,
}: {
  initial: CategoryInput;
  categories: CategoryRow[];
  excludeId?: string;
  onSubmit: (input: CategoryInput) => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<CategoryInput>(initial);
  const parentOptions = categories.filter((c) => c.id !== excludeId);
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="category-name">Name</Label>
        <Input id="category-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="category-parent">Parent</Label>
        <select
          id="category-parent"
          className="w-full rounded border bg-transparent p-2 text-sm"
          value={form.parentId ?? ""}
          onChange={(e) => setForm({ ...form, parentId: e.target.value || null })}
        >
          <option value="">No parent (top level)</option>
          {parentOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.path}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="category-description">Description (the rule)</Label>
        <textarea
          id="category-description"
          className="w-full min-h-24 rounded-[1.75rem] border bg-secondary px-4 py-3 text-sm"
          maxLength={2000}
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <p className="text-xs text-muted-foreground mt-1">{(form.description ?? "").length}/2000. Leave empty to keep this category manual only.</p>
      </div>
      <div className="flex items-center gap-3">
        <Label htmlFor="category-color">Color</Label>
        <Input
          id="category-color"
          value={form.color ?? ""}
          placeholder="#4f46e5"
          className="w-32"
          onChange={(e) => setForm({ ...form, color: e.target.value || null })}
        />
        {form.color && <span className="inline-block h-5 w-5 rounded border" style={{ backgroundColor: form.color }} />}
      </div>
      <div>
        <Label htmlFor="category-threshold">Confidence threshold: {(form.confidenceThreshold ?? 0.7).toFixed(2)}</Label>
        <input
          id="category-threshold"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.confidenceThreshold ?? 0.7}
          className="w-full accent-primary"
          onChange={(e) => setForm({ ...form, confidenceThreshold: Number(e.target.value) })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary"
          checked={form.autoApply ?? true}
          onChange={(e) => setForm({ ...form, autoApply: e.target.checked })}
        />
        Automatic: let the sorter file documents here
      </label>
      <Button disabled={submitting || !form.name.trim()} onClick={() => onSubmit(form)}>
        Save
      </Button>
      <DryRunPanel targetType="category" name={form.name} description={form.description ?? ""} threshold={form.confidenceThreshold ?? 0.7} />
    </div>
  );
}

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = useState<CategoryRow | null>(null);

  const create = useMutation({
    mutationFn: (input: CategoryInput) => categoriesApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setCreateOpen(false);
      toast.success("Category created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (input: CategoryInput) => categoriesApi.update(editing!.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setEditing(null);
      toast.success("Category saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setDeleting(null);
      toast.success("Category deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reorder = useMutation({
    mutationFn: ([a, b]: [{ id: string; sortOrder: number }, { id: string; sortOrder: number }]) =>
      Promise.all([categoriesApi.update(a.id, { sortOrder: a.sortOrder }), categoriesApi.update(b.id, { sortOrder: b.sortOrder })]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["categories"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  function siblingsOf(category: CategoryRow): CategoryRow[] {
    return categories.filter((c) => c.parentId === category.parentId).sort((x, y) => x.sortOrder - y.sortOrder);
  }

  function moveCategory(category: CategoryRow, direction: -1 | 1) {
    const siblings = siblingsOf(category);
    const index = siblings.findIndex((c) => c.id === category.id);
    const neighbor = siblings[index + direction];
    if (!neighbor) return;
    reorder.mutate([
      { id: category.id, sortOrder: neighbor.sortOrder },
      { id: neighbor.id, sortOrder: category.sortOrder },
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl">Categories</h1>
        <Button onClick={() => setCreateOpen(true)}>New category</Button>
      </div>

      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <div className="grid gap-3">
          {categories.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {c.color && <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: c.color }} />}
                  {c.path}
                  <Badge variant="accent2">
                    {c.documentCount} {c.documentCount === 1 ? "document" : "documents"}
                  </Badge>
                  {!c.autoApply && <Badge variant="neutral">Manual only</Badge>}
                </CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" aria-label={`Move ${c.name} up`} onClick={() => moveCategory(c, -1)}>
                    Up
                  </Button>
                  <Button size="sm" variant="outline" aria-label={`Move ${c.name} down`} onClick={() => moveCategory(c, 1)}>
                    Down
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(c)}>
                    Delete
                  </Button>
                </div>
              </CardHeader>
              {c.description && <CardContent className="text-sm text-muted-foreground">{c.description}</CardContent>}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
          </DialogHeader>
          <CategoryForm initial={emptyForm} categories={categories} submitting={create.isPending} onSubmit={(input) => create.mutate(input)} />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit category</DialogTitle>
          </DialogHeader>
          {editing && (
            <CategoryForm
              initial={{
                name: editing.name,
                parentId: editing.parentId,
                color: editing.color,
                description: editing.description,
                confidenceThreshold: editing.confidenceThreshold,
                autoApply: editing.autoApply,
              }}
              categories={categories}
              excludeId={editing.id}
              submitting={update.isPending}
              onSubmit={(input) => update.mutate(input)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this category?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Its subcategories move up one level and its documents lose this category. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleting && remove.mutate(deleting.id)} disabled={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
