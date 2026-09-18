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
import { DescriptionAssistant } from "@/components/forms/DescriptionAssistant";
import { DryRunPanel } from "@/components/sorting/DryRunPanel";
import { typesApi, type DocumentTypeInput, type DocumentTypeRow } from "@/lib/types-api";

const emptyForm: DocumentTypeInput = { name: "", color: "", description: "", confidenceThreshold: 0.7, autoApply: true };

function TypeForm({ initial, onSubmit, submitting }: { initial: DocumentTypeInput; onSubmit: (input: DocumentTypeInput) => void; submitting: boolean }) {
  const [form, setForm] = useState<DocumentTypeInput>(initial);
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="type-name">Name</Label>
        <Input id="type-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="type-description">Description (the rule)</Label>
          <DescriptionAssistant
            targetType="type"
            name={form.name}
            description={form.description ?? ""}
            onUse={(text) => setForm({ ...form, description: text })}
          />
        </div>
        <textarea
          id="type-description"
          className="w-full min-h-24 rounded-[1.75rem] border bg-secondary px-4 py-3 text-sm"
          maxLength={2000}
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <p className="text-xs text-muted-foreground mt-1">{(form.description ?? "").length}/2000. Leave empty to keep this type manual only.</p>
      </div>
      <div>
        <Label>Color</Label>
        <ColorPicker idPrefix="type" value={form.color ?? null} onChange={(color) => setForm({ ...form, color })} />
      </div>
      <div>
        <Label htmlFor="type-threshold">Confidence threshold: {(form.confidenceThreshold ?? 0.7).toFixed(2)}</Label>
        <input
          id="type-threshold"
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
        Automatic: let the sorter apply this type
      </label>
      <Button disabled={submitting || !form.name.trim()} onClick={() => onSubmit(form)}>
        Save
      </Button>
      <DryRunPanel targetType="type" name={form.name} description={form.description ?? ""} threshold={form.confidenceThreshold ?? 0.7} />
    </div>
  );
}

export function TypesPage() {
  const queryClient = useQueryClient();
  const { data: types = [] } = useQuery({ queryKey: ["types"], queryFn: typesApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<DocumentTypeRow | null>(null);
  const [deleting, setDeleting] = useState<DocumentTypeRow | null>(null);

  const create = useMutation({
    mutationFn: (input: DocumentTypeInput) => typesApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["types"] });
      setCreateOpen(false);
      toast.success("Type created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (input: DocumentTypeInput) => typesApi.update(editing!.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["types"] });
      setEditing(null);
      toast.success("Type saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => typesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["types"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setDeleting(null);
      toast.success("Type deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl">Types</h1>
        <Button onClick={() => setCreateOpen(true)}>New type</Button>
      </div>

      {types.length === 0 ? (
        <p className="text-sm text-muted-foreground">No types yet.</p>
      ) : (
        <div className="grid gap-3">
          {types.map((t) => (
            <Card key={t.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {t.color && <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: t.color }} />}
                  {t.name}
                  <Badge variant="accent2">
                    {t.documentCount} {t.documentCount === 1 ? "document" : "documents"}
                  </Badge>
                  {!t.autoApply && <Badge variant="neutral">Manual only</Badge>}
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
            <DialogTitle>New type</DialogTitle>
          </DialogHeader>
          <TypeForm initial={emptyForm} submitting={create.isPending} onSubmit={(input) => create.mutate(input)} />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit type</DialogTitle>
          </DialogHeader>
          {editing && (
            <TypeForm
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
            <DialogTitle>Delete this type?</DialogTitle>
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
