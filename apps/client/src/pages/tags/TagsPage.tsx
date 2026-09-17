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
import { tagsApi, type TagInput, type TagRow } from "@/lib/tags-api";

const emptyForm: TagInput = { name: "", color: "", description: "", confidenceThreshold: 0.7, autoApply: true };

function TagForm({ initial, onSubmit, submitting }: { initial: TagInput; onSubmit: (input: TagInput) => void; submitting: boolean }) {
  const [form, setForm] = useState<TagInput>(initial);
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="tag-name">Name</Label>
        <Input id="tag-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="tag-description">Description (the rule)</Label>
        <textarea
          id="tag-description"
          className="w-full min-h-24 rounded border bg-transparent p-2 text-sm"
          maxLength={300}
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <p className="text-xs text-muted-foreground mt-1">{(form.description ?? "").length}/300. Leave empty to keep this tag manual only.</p>
      </div>
      <div className="flex items-center gap-3">
        <Label htmlFor="tag-color">Color</Label>
        <Input
          id="tag-color"
          value={form.color ?? ""}
          placeholder="#4f46e5"
          className="w-32"
          onChange={(e) => setForm({ ...form, color: e.target.value || null })}
        />
        {form.color && <span className="inline-block h-5 w-5 rounded border" style={{ backgroundColor: form.color }} />}
      </div>
      <div>
        <Label htmlFor="tag-threshold">Confidence threshold: {(form.confidenceThreshold ?? 0.7).toFixed(2)}</Label>
        <input
          id="tag-threshold"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.confidenceThreshold ?? 0.7}
          className="w-full"
          onChange={(e) => setForm({ ...form, confidenceThreshold: Number(e.target.value) })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.autoApply ?? true} onChange={(e) => setForm({ ...form, autoApply: e.target.checked })} />
        Automatic: let the sorter apply this tag
      </label>
      <Button disabled={submitting || !form.name.trim()} onClick={() => onSubmit(form)}>
        Save
      </Button>
      <DryRunPanel targetType="tag" name={form.name} description={form.description ?? ""} threshold={form.confidenceThreshold ?? 0.7} />
    </div>
  );
}

export function TagsPage() {
  const queryClient = useQueryClient();
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TagRow | null>(null);
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const create = useMutation({
    mutationFn: (input: TagInput) => tagsApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setCreateOpen(false);
      toast.success("Tag created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (input: TagInput) => tagsApi.update(editing!.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setEditing(null);
      toast.success("Tag saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => tagsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setDeleting(null);
      toast.success("Tag deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tags</h1>
        <Button onClick={() => setCreateOpen(true)}>New tag</Button>
      </div>

      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags yet.</p>
      ) : (
        <div className="grid gap-3">
          {tags.map((t) => (
            <Card key={t.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {t.color && <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: t.color }} />}
                  {t.name}
                  <Badge variant="secondary">
                    {t.documentCount} {t.documentCount === 1 ? "document" : "documents"}
                  </Badge>
                  {!t.autoApply && <Badge variant="outline">Manual only</Badge>}
                </CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(t)}>
                    Delete
                  </Button>
                </div>
              </CardHeader>
              {t.description && <CardContent className="text-sm text-muted-foreground">{t.description}</CardContent>}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New tag</DialogTitle>
          </DialogHeader>
          <TagForm initial={emptyForm} submitting={create.isPending} onSubmit={(input) => create.mutate(input)} />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit tag</DialogTitle>
          </DialogHeader>
          {editing && (
            <TagForm
              initial={{
                name: editing.name,
                color: editing.color,
                description: editing.description,
                confidenceThreshold: editing.confidenceThreshold,
                autoApply: editing.autoApply,
              }}
              submitting={update.isPending}
              onSubmit={(input) => update.mutate(input)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this tag?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Removes it from every document. This cannot be undone.</p>
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
