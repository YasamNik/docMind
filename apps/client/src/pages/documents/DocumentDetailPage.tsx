import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { documentsApi, type DocumentDetail } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";
import { jobsApi } from "@/lib/jobs-api";
import { sortApi, type ProposalRow } from "@/lib/sort-api";
import { categoriesApi, documentCategorizationApi, tagsApi } from "@/lib/tags-api";

function Preview({ id, mimeType }: { id: string; mimeType: string | null }) {
  const url = documentsApi.fileUrl(id);
  if (mimeType === "application/pdf")
    return <iframe title="Preview" src={url} className="w-full h-[70vh] rounded-[28px] border border-border" />;
  if (mimeType?.startsWith("image/"))
    return <img src={url} alt="Preview" className="max-h-[70vh] rounded-[28px] border border-border" />;
  return (
    <div className="flex items-center justify-center rounded-[28px] bg-org-neutral-200 p-10 text-center">
      <p className="text-sm text-muted-foreground">
        No inline preview for this type.{" "}
        <a className="underline" href={documentsApi.fileUrl(id, true)}>
          Download
        </a>
      </p>
    </div>
  );
}

function CategoryPicker({ document, id, queryClient }: { document: DocumentDetail; id: string; queryClient: ReturnType<typeof useQueryClient> }) {
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const setCategory = useMutation({
    mutationFn: (categoryId: string | null) => documentCategorizationApi.setCategory(id, categoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      toast.success("Category updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex items-center gap-2">
      <select
        className="rounded-full border border-input bg-secondary px-3 py-1.5 text-sm"
        value={document.categoryId ?? ""}
        onChange={(e) => setCategory.mutate(e.target.value || null)}
      >
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.path}
          </option>
        ))}
      </select>
      {document.categorySource === "auto" && <Badge variant="neutral">Auto</Badge>}
    </div>
  );
}

function TagPicker({ document, id, queryClient }: { document: DocumentDetail; id: string; queryClient: ReturnType<typeof useQueryClient> }) {
  const { data: allTags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });
  const addTag = useMutation({
    mutationFn: (tagId: string) => documentCategorizationApi.addTag(id, tagId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      toast.success("Tag added");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeTag = useMutation({
    mutationFn: (tagId: string) => documentCategorizationApi.removeTag(id, tagId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      toast.success("Tag removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const attachedIds = new Set(document.tags.map((t) => t.id));
  const available = allTags.filter((t) => !attachedIds.has(t.id));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {document.tags.map((t) => (
        <Badge key={t.id} variant={t.auto ? "accent2" : "accent"} className="flex items-center gap-1">
          {t.name}
          {t.auto && <span className="text-[10px] opacity-70">(auto)</span>}
          <button type="button" aria-label={`Remove ${t.name}`} className="ml-1" onClick={() => removeTag.mutate(t.id)}>
            x
          </button>
        </Badge>
      ))}
      {available.length > 0 && (
        <select
          className="rounded-full border border-input bg-secondary px-3 py-1 text-xs"
          value=""
          onChange={(e) => e.target.value && addTag.mutate(e.target.value)}
        >
          <option value="">Add a tag</option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ProposalsReview({ documentId, queryClient }: { documentId: string; queryClient: ReturnType<typeof useQueryClient> }) {
  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => jobsApi.list(),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "pending" || j.status === "processing") ? 3000 : false),
  });
  const rulesJobPending = jobs.some((j) => j.type === "rules" && j.payload.documentId === documentId && (j.status === "pending" || j.status === "processing"));
  const { data: proposals = [] } = useQuery<ProposalRow[]>({
    queryKey: ["proposals", documentId],
    queryFn: () => sortApi.listForDocument(documentId),
    refetchInterval: rulesJobPending ? 3000 : false,
  });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const apply = useMutation({
    mutationFn: ({ accept, dismiss }: { accept: string[]; dismiss: string[] }) => sortApi.apply(accept, dismiss),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proposals", documentId] });
      queryClient.invalidateQueries({ queryKey: ["documents", documentId] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setSelected(new Set());
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (proposals.length === 0) return null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Review proposals ({proposals.length})
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Proposed changes</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-[50vh] overflow-auto">
            {proposals.map((p) => {
              const label = p.kind === "add_tag" ? `Add tag ${p.itemName}` : p.kind === "remove_tag" ? `Remove tag ${p.itemName}` : `Set category to ${p.itemName}`;
              return (
                <label key={p.id} className="flex items-start gap-2 text-sm border-b pb-2 last:border-b-0">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="mt-1" />
                  <span>
                    {label}
                    <span className="block text-xs text-muted-foreground">{p.reasoning}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => apply.mutate({ accept: [], dismiss: proposals.map((p) => p.id) })} disabled={apply.isPending}>
              Dismiss all
            </Button>
            <Button onClick={() => apply.mutate({ accept: [...selected], dismiss: [] })} disabled={selected.size === 0 || apply.isPending}>
              Accept selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DocumentDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: document } = useQuery<DocumentDetail>({
    queryKey: ["documents", id],
    queryFn: () => documentsApi.get(id),
    refetchInterval: (q) => (q.state.data && (q.state.data.extractionStatus === "pending" || q.state.data.extractionStatus === "processing") ? 3000 : false),
  });
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState("");

  const rename = useMutation({
    mutationFn: () => documentsApi.rename(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      setRenameOpen(false);
      toast.success("Renamed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => documentsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      navigate("/documents");
      toast.success("Deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reextract = useMutation({
    mutationFn: () => documentsApi.reextract(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Extraction queued");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const runRules = useMutation({
    mutationFn: () => sortApi.requestSort(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Sorting queued");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const acceptTitle = useMutation({
    mutationFn: () => documentsApi.acceptTitle(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Title updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!document) return null;

  const extractionBadgeVariant = document.extractionStatus === "failed" ? "destructive" : document.extractionStatus === "done" ? "accent2" : "neutral";
  const hasSuggestedTitle = Boolean(document.suggestedTitle && document.suggestedTitle !== document.name);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          {document.categoryPath && (
            <p className="text-[10px] uppercase tracking-widest text-primary font-semibold">
              {document.categoryPath}
              {document.categorySource === "auto" ? " · auto-filed" : ""}
            </p>
          )}
          <h1 className="font-heading text-2xl break-all mt-1">{document.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {document.mimeType ?? "unknown type"} · {document.sizeBytes == null ? "" : formatBytes(document.sizeBytes)} · added {formatDate(document.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" render={<a href={documentsApi.fileUrl(id, true)} />}>
            Download
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setName(document.name);
              setRenameOpen(true);
            }}
          >
            Rename
          </Button>
          <Button variant="secondary" onClick={() => runRules.mutate()} disabled={runRules.isPending}>
            Run rules
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      {hasSuggestedTitle && (
        <div className="flex flex-wrap items-center gap-2 rounded-full bg-org-accent-100 px-3 py-1.5 text-org-accent-800">
          <Badge variant="accent">Suggested title</Badge>
          <span className="text-sm">{document.suggestedTitle}</span>
          <Button size="sm" variant="secondary" className="rounded-full" onClick={() => acceptTitle.mutate()} disabled={acceptTitle.isPending}>
            Accept
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <CategoryPicker document={document} id={id} queryClient={queryClient} />
        <TagPicker document={document} id={id} queryClient={queryClient} />
        <ProposalsReview documentId={id} queryClient={queryClient} />
      </div>

      <Preview id={id} mimeType={document.mimeType} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            Text
            <Badge variant={extractionBadgeVariant}>{document.extractionStatus}</Badge>
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => reextract.mutate()} disabled={reextract.isPending}>
            Re-extract
          </Button>
        </CardHeader>
        <CardContent>
          {document.extractionError && <p className="text-sm text-muted-foreground mb-2">{document.extractionError}</p>}
          {document.extractedText ? (
            <pre className="whitespace-pre-wrap break-words text-sm max-h-[50vh] overflow-auto">{document.extractedText}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {document.extractionStatus === "done" ? "No text was found in this document." : "Text appears here once extraction finishes."}
            </p>
          )}
        </CardContent>
      </Card>

      {(document.summary || document.summaryStatus === "processing" || document.summaryStatus === "failed") && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              Summary
              {document.summaryStatus === "processing" && <Badge variant="neutral">Summarizing...</Badge>}
              {document.summaryStatus === "failed" && <Badge variant="destructive">Failed</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {document.summaryStatus === "failed" && document.summaryError && (
              <p className="text-sm text-muted-foreground mb-2">{document.summaryError}</p>
            )}
            {document.summary && <p className="text-sm">{document.summary}</p>}
          </CardContent>
        </Card>
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename document</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => rename.mutate()} disabled={rename.isPending || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this document?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">The file is removed from storage. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
