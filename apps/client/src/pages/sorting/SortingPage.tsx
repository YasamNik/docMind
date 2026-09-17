import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { categoriesApi, tagsApi, type CategoryRow, type TagRow } from "@/lib/tags-api";
import { jobsApi } from "@/lib/jobs-api";
import { sortApi, type ProposalRow, type SortScope } from "@/lib/sort-api";

type AutomaticItem = { targetType: "tag" | "category"; id: string; name: string; description: string };

function automaticItemsFrom(tags: TagRow[], categories: CategoryRow[]): AutomaticItem[] {
  const autoTags = tags
    .filter((t) => t.autoApply && t.description.trim() !== "")
    .map((t) => ({ targetType: "tag" as const, id: t.id, name: t.name, description: t.description }));
  const autoCategories = categories
    .filter((c) => c.autoApply && c.description.trim() !== "")
    .map((c) => ({ targetType: "category" as const, id: c.id, name: c.path, description: c.description }));
  return [...autoTags, ...autoCategories];
}

function RunDialog({ item, onClose }: { item: AutomaticItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<SortScope>("needs_review");
  const { data: count = 0 } = useQuery({ queryKey: ["sort-count", scope], queryFn: () => sortApi.count(scope) });
  const run = useMutation({
    mutationFn: () => sortApi.run(item.targetType, item.id, scope),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      toast.success(`Queued ${result.count} document${result.count === 1 ? "" : "s"} for rerun`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run &quot;{item.name}&quot; over</DialogTitle>
        </DialogHeader>
        <select className="w-full rounded border bg-transparent p-2 text-sm" value={scope} onChange={(e) => setScope(e.target.value as SortScope)}>
          <option value="needs_review">Needs review</option>
          <option value="all">All documents</option>
        </select>
        <p className="text-sm text-muted-foreground">
          {count} document{count === 1 ? "" : "s"} will be re-evaluated against this item.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending || count === 0}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProposalRowView({ proposal, checked, onToggle }: { proposal: ProposalRow; checked: boolean; onToggle: () => void }) {
  const kindLabel = proposal.kind === "add_tag" ? "Add tag" : proposal.kind === "remove_tag" ? "Remove tag" : "Set category";
  return (
    <div className="flex items-start gap-3 border-b py-3 last:border-b-0">
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1" aria-label={`Select proposal for ${proposal.documentName}`} />
      <div className="flex-1">
        <p className="text-sm">
          <span className="font-medium">{proposal.documentName}</span>: {kindLabel} <span className="font-medium">{proposal.itemName}</span>
          <Badge variant="secondary" className="ml-2">
            {Math.round(proposal.confidence * 100)}%
          </Badge>
        </p>
        <p className="text-xs text-muted-foreground">{proposal.reasoning}</p>
      </div>
    </div>
  );
}

export function SortingPage() {
  const queryClient = useQueryClient();
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => jobsApi.list(),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "pending" || j.status === "processing") ? 3000 : false),
  });
  const rulesJobsPending = jobs.some((j) => j.type === "rules" && (j.status === "pending" || j.status === "processing"));
  const { data: proposalsResult } = useQuery({ queryKey: ["proposals"], queryFn: () => sortApi.list(), refetchInterval: rulesJobsPending ? 3000 : false });
  const [runningItem, setRunningItem] = useState<AutomaticItem | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const items = automaticItemsFrom(tags, categories);
  const proposals = proposalsResult?.proposals ?? [];

  const apply = useMutation({
    mutationFn: ({ accept, dismiss }: { accept: string[]; dismiss: string[] }) => sortApi.apply(accept, dismiss),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setSelected(new Set());
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Sorting</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automatic items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tag or category has both a description and automatic sorting turned on yet.</p>
          ) : (
            <>
              {items.length > 20 && (
                <p className="text-xs text-muted-foreground">{items.length} automatic items. Very many long descriptions cost more per document to sort.</p>
              )}
              {items.map((item) => (
                <div key={`${item.targetType}:${item.id}`} className="flex items-center justify-between gap-2 border-b py-2 last:border-b-0">
                  <div>
                    <p className="text-sm font-medium">
                      {item.name} <Badge variant="outline">{item.targetType}</Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setRunningItem(item)}>
                    Run
                  </Button>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Proposed changes</CardTitle>
          {proposals.length > 0 && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => apply.mutate({ accept: [...selected], dismiss: [] })} disabled={selected.size === 0 || apply.isPending}>
                Accept selected
              </Button>
              <Button size="sm" onClick={() => apply.mutate({ accept: proposals.map((p) => p.id), dismiss: [] })} disabled={apply.isPending}>
                Accept all
              </Button>
              <Button size="sm" variant="destructive" onClick={() => apply.mutate({ accept: [], dismiss: [...selected] })} disabled={selected.size === 0 || apply.isPending}>
                Dismiss selected
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No proposals waiting.</p>
          ) : (
            proposals.map((p) => <ProposalRowView key={p.id} proposal={p} checked={selected.has(p.id)} onToggle={() => toggle(p.id)} />)
          )}
        </CardContent>
      </Card>

      {runningItem && <RunDialog item={runningItem} onClose={() => setRunningItem(null)} />}
    </div>
  );
}
