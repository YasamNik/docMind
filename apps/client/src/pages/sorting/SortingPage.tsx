import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { categoriesApi, tagsApi, type CategoryRow, type TagRow } from "@/lib/tags-api";
import { jobsApi, type JobRow } from "@/lib/jobs-api";
import { documentsApi, type DocumentRow } from "@/lib/documents-api";
import { fieldsApi } from "@/lib/fields-api";
import { sortApi, type ProposalRow, type RuleSuggestion, type SortScope } from "@/lib/sort-api";
import { typesApi, type DocumentTypeRow } from "@/lib/types-api";

type AutomaticItem = { targetType: "tag" | "category" | "type"; id: string; name: string; description: string };

// A batch is the set of rules jobs belonging to one sorting run. When the run was
// started from this page we know its job ids exactly; otherwise we fall back to
// grouping the most recently created rules jobs by the second they were queued in.
function secondKey(iso: string): string {
  return iso.slice(0, 19);
}

function pickBatch(rulesJobs: JobRow[], trackedIds: string[] | null): JobRow[] {
  if (trackedIds && trackedIds.length > 0) {
    const tracked = rulesJobs.filter((j) => trackedIds.includes(j.id));
    if (tracked.length > 0) return tracked;
  }
  if (rulesJobs.length === 0) return [];
  const latestCreatedAt = rulesJobs.reduce((max, j) => (j.createdAt > max ? j.createdAt : max), rulesJobs[0]!.createdAt);
  const key = secondKey(latestCreatedAt);
  return rulesJobs.filter((j) => secondKey(j.createdAt) === key);
}

type JobOutcome = "applied" | "proposed" | "no_match" | "failed";

// A completed rerun job never generates a proposal when the item was already applied
// (or already did not match), so "applied" versus "no match" can only be told apart by
// checking the document's current tags and category against the job's target.
function classifyJob(job: JobRow, documents: DocumentRow[], proposals: ProposalRow[]): JobOutcome {
  if (job.status === "failed") return "failed";
  const documentId = job.payload.documentId;
  const targetType = job.payload.targetType as "tag" | "category" | "type" | undefined;
  const targetId = job.payload.targetId as string | undefined;
  const hasProposal = proposals.some((p) => p.documentId === documentId && (!targetId || (p.targetType === targetType && p.targetId === targetId)));
  if (hasProposal) return "proposed";
  if (targetType && targetId && documentId) {
    const doc = documents.find((d) => d.id === documentId);
    const applied = doc
      ? targetType === "tag"
        ? doc.tags.some((t) => t.id === targetId)
        : targetType === "type"
          ? doc.documentTypeId === targetId
          : doc.categoryId === targetId
      : false;
    if (applied) return "applied";
  }
  return "no_match";
}

function summarizeBatch(batch: JobRow[], documents: DocumentRow[], proposals: ProposalRow[]) {
  const finished = batch.filter((j) => j.status === "done" || j.status === "failed");
  const counts = { applied: 0, proposed: 0, no_match: 0, failed: 0 };
  for (const job of finished) counts[classifyJob(job, documents, proposals)] += 1;
  return { ...counts, completed: finished.length, total: batch.length };
}

function activityBadge(status: JobRow["status"]): { variant: "accent" | "accent2" | "destructive"; label: string; pulse: boolean } {
  if (status === "failed") return { variant: "destructive", label: "failed", pulse: false };
  if (status === "done") return { variant: "accent2", label: "done", pulse: false };
  if (status === "processing") return { variant: "accent", label: "processing", pulse: true };
  return { variant: "accent", label: "pending", pulse: false };
}

function SortingActivityCard({
  rulesJobs,
  batch,
  documents,
  proposals,
}: {
  rulesJobs: JobRow[];
  batch: JobRow[];
  documents: DocumentRow[];
  proposals: ProposalRow[];
}) {
  if (rulesJobs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sorting activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No recent sorting activity.</p>
        </CardContent>
      </Card>
    );
  }

  const isActive = batch.some((j) => j.status === "pending" || j.status === "processing");
  const summary = summarizeBatch(batch, documents, proposals);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sorting activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isActive ? (
          <p className="text-sm font-medium">
            Sorting {batch.length} document{batch.length === 1 ? "" : "s"}... ({summary.completed}/{batch.length})
          </p>
        ) : (
          <p className="text-sm font-medium">
            Completed: {summary.applied} applied, {summary.proposed} proposed, {summary.no_match} no match
            {summary.failed > 0 ? `, ${summary.failed} failed` : ""}
          </p>
        )}
        {batch.length > 1 && (
          <div className="h-2 w-full rounded-full bg-org-neutral-200">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${Math.round((summary.completed / batch.length) * 100)}%` }}
            />
          </div>
        )}
        <div className="space-y-1">
          {batch.map((job) => {
            const name = documents.find((d) => d.id === job.payload.documentId)?.name ?? job.payload.documentId ?? "Unknown document";
            const badge = activityBadge(job.status);
            return (
              <div key={job.id} className="flex items-center justify-between gap-2 border-b py-1 last:border-b-0">
                <span className="truncate text-sm">{name}</span>
                <Badge variant={badge.variant} className={badge.pulse ? "animate-pulse" : undefined}>
                  {badge.label}
                </Badge>
              </div>
            );
          })}
        </div>
        {!isActive && summary.proposed > 0 && (
          <a href="#proposed-changes" className="block text-xs text-muted-foreground underline-offset-2 hover:underline">
            {summary.proposed} proposal{summary.proposed === 1 ? "" : "s"} waiting below
          </a>
        )}
      </CardContent>
    </Card>
  );
}

function automaticItemsFrom(tags: TagRow[], categories: CategoryRow[], types: DocumentTypeRow[]): AutomaticItem[] {
  const autoTags = tags
    .filter((t) => t.autoApply && t.description.trim() !== "")
    .map((t) => ({ targetType: "tag" as const, id: t.id, name: t.name, description: t.description }));
  const autoCategories = categories
    .filter((c) => c.autoApply && c.description.trim() !== "")
    .map((c) => ({ targetType: "category" as const, id: c.id, name: c.path, description: c.description }));
  const autoTypes = types
    .filter((t) => t.autoApply && t.description.trim() !== "")
    .map((t) => ({ targetType: "type" as const, id: t.id, name: t.name, description: t.description }));
  return [...autoTags, ...autoCategories, ...autoTypes];
}

function RunDialog({ item, onClose, onQueued }: { item: AutomaticItem; onClose: () => void; onQueued: (jobIds: string[]) => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<SortScope>("needs_review");
  const { data: count = 0 } = useQuery({ queryKey: ["sort-count", scope], queryFn: () => sortApi.count(scope) });
  const run = useMutation({
    mutationFn: () => sortApi.run(item.targetType, item.id, scope),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      onQueued(result.jobIds);
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

// A document counts as a backfill candidate once its extraction is done and it has not
// been through smart field extraction yet, the same rule enqueueBackfill applies on the
// server. The count here is only for stating the cost before confirming; the server
// makes the real decision when the request lands.
function countBackfillCandidates(documents: DocumentRow[]): number {
  return documents.filter((d) => d.extractionStatus === "done" && (d.fields?.length ?? 0) === 0).length;
}

function FieldsBackfillDialog({ count, onClose, onQueued }: { count: number; onClose: () => void; onQueued: (result: { enqueued: number; skipped: number }) => void }) {
  const queryClient = useQueryClient();
  const backfill = useMutation({
    mutationFn: () => fieldsApi.backfill(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onQueued(result);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extract fields for all documents?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will run one model call for each of {count} document{count === 1 ? "" : "s"} that has not been through
          smart field extraction yet. Documents already extracted are skipped.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => backfill.mutate()} disabled={backfill.isPending}>
            Extract fields
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
  const { data: types = [] } = useQuery({ queryKey: ["types"], queryFn: typesApi.list });
  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => jobsApi.list(),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "pending" || j.status === "processing") ? 3000 : false),
  });
  const rulesJobs = jobs.filter((j) => j.type === "rules");
  const rulesJobsPending = rulesJobs.some((j) => j.status === "pending" || j.status === "processing");
  const { data: proposalsResult } = useQuery({ queryKey: ["proposals"], queryFn: () => sortApi.list(), refetchInterval: rulesJobsPending ? 3000 : false });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", "sorting-activity"],
    queryFn: () => documentsApi.list(),
    enabled: rulesJobs.length > 0,
    refetchInterval: rulesJobsPending ? 3000 : false,
  });
  const { data: allDocuments = [] } = useQuery({
    queryKey: ["documents", "fields-backfill-candidates"],
    queryFn: () => documentsApi.list(),
  });
  const [runningItem, setRunningItem] = useState<AutomaticItem | null>(null);
  const [currentBatchIds, setCurrentBatchIds] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);

  const suggest = useMutation({
    mutationFn: () => sortApi.suggest(),
    onSuccess: (data) => { setSuggestions(data.suggestions); setSuggestOpen(true); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = automaticItemsFrom(tags, categories, types);
  const proposals = proposalsResult?.proposals ?? [];
  const batch = pickBatch(rulesJobs, currentBatchIds);

  const apply = useMutation({
    mutationFn: ({ accept, dismiss }: { accept: string[]; dismiss: string[] }) => sortApi.apply(accept, dismiss),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      queryClient.invalidateQueries({ queryKey: ["types"] });
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
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl">Sorting</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setBackfillOpen(true)}>
            Extract fields for all documents
          </Button>
          <Button size="sm" variant="outline" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
            {suggest.isPending ? "Analyzing..." : "Suggest rules"}
          </Button>
        </div>
      </div>

      <Dialog open={suggestOpen} onOpenChange={setSuggestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rule suggestions</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-3 overflow-auto">
            {suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No suggestions. Upload more documents for better results.</p>
            ) : (
              suggestions.map((s, i) => (
                <div key={i} className="rounded-lg border p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{s.name}</span>
                    <Badge variant="outline">{s.type}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{s.description}</p>
                  <p className="text-xs text-muted-foreground italic">{s.reasoning}</p>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <p className="text-xs text-muted-foreground">Create these as tags and categories on their own pages, then enable auto-sorting.</p>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automatic items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tag, category, or type has both a description and automatic sorting turned on yet.</p>
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

      <SortingActivityCard rulesJobs={rulesJobs} batch={batch} documents={documents} proposals={proposals} />

      <Card id="proposed-changes">
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

      {runningItem && <RunDialog item={runningItem} onClose={() => setRunningItem(null)} onQueued={setCurrentBatchIds} />}
      {backfillOpen && (
        <FieldsBackfillDialog
          count={countBackfillCandidates(allDocuments)}
          onClose={() => setBackfillOpen(false)}
          onQueued={(result) =>
            toast.success(`Queued ${result.enqueued} document${result.enqueued === 1 ? "" : "s"} for field extraction${result.skipped > 0 ? `, skipped ${result.skipped} already running` : ""}`)
          }
        />
      )}
    </div>
  );
}
