import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ColorPicker } from "@/components/forms/ColorPicker";
import { budgetApi, type BudgetCategory, type BudgetCategoryInput } from "@/lib/budget-api";

const emptyForm: BudgetCategoryInput = { name: "", description: "", color: null, autoApply: true };

// Same shape as the sorter's automatic count on the Sorting page: only a category that is
// both auto-apply and has something written in it actually costs anything, since an empty
// description contributes nothing to the prompt the receipt job builds.
function countAutomatic(categories: BudgetCategory[]): number {
  return categories.filter((c) => c.autoApply === 1 && c.description.trim() !== "").length;
}

function CategoryForm({
  initial,
  onSubmit,
  submitting,
}: {
  initial: BudgetCategoryInput;
  onSubmit: (input: BudgetCategoryInput) => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<BudgetCategoryInput>(initial);
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="budget-category-name">Name</Label>
        <Input id="budget-category-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="budget-category-description">Description</Label>
        <textarea
          id="budget-category-description"
          className="w-full min-h-24 rounded-[1.75rem] border bg-secondary px-4 py-3 text-sm"
          maxLength={2000}
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <p className="text-xs text-muted-foreground mt-1">{(form.description ?? "").length}/2000. Leave empty to keep this category manual only.</p>
      </div>
      <div>
        <Label>Color</Label>
        <ColorPicker idPrefix="budget-category" value={form.color ?? null} onChange={(color) => setForm({ ...form, color })} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary"
          checked={form.autoApply ?? true}
          onChange={(e) => setForm({ ...form, autoApply: e.target.checked })}
        />
        Automatic: let receipt reading apply this category
      </label>
      <Button disabled={submitting || !form.name.trim()} onClick={() => onSubmit(form)}>
        Save
      </Button>
    </div>
  );
}

export function BudgetCategoriesPage() {
  const queryClient = useQueryClient();
  const { data: categories = [] } = useQuery({ queryKey: ["budget", "categories"], queryFn: budgetApi.listCategories });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetCategory | null>(null);
  const [deleting, setDeleting] = useState<BudgetCategory | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["budget", "categories"] });

  const create = useMutation({
    mutationFn: (input: BudgetCategoryInput) => budgetApi.createCategory(input),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      toast.success("Category created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (input: BudgetCategoryInput) => budgetApi.updateCategory(editing!.id, input),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      toast.success("Category saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => budgetApi.removeCategory(id),
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["budget", "receipts"] });
      setDeleting(null);
      toast.success("Category deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const automaticCount = countAutomatic(categories);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl">Budget categories</h1>
        <Button onClick={() => setCreateOpen(true)}>New category</Button>
      </div>

      <p className="text-sm text-muted-foreground">
        One list, read both for a receipt as a whole and for every line on it. The description is the text the
        model reads when deciding, so a clear one is what makes categorisation good, and a vague one gets guessed.
        {" "}
        {automaticCount} automatic {automaticCount === 1 ? "category goes" : "categories go"} into every receipt read.
      </p>

      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <div className="grid gap-3">
          {categories.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {c.color && <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: c.color }} />}
                  {c.name}
                  {c.autoApply !== 1 && <Badge variant="neutral">Manual only</Badge>}
                </CardTitle>
                <div className="flex gap-2">
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
          <CategoryForm initial={emptyForm} submitting={create.isPending} onSubmit={(input) => create.mutate(input)} />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit category</DialogTitle>
          </DialogHeader>
          {editing && (
            <CategoryForm
              initial={{ name: editing.name, description: editing.description, color: editing.color, autoApply: editing.autoApply === 1 }}
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
          <p className="text-sm text-muted-foreground">
            Removes it from every receipt and line that used it, leaving them uncategorised. This cannot be undone.
          </p>
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
