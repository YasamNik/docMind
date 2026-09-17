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
import { categoriesApi, documentCategorizationApi, tagsApi } from "@/lib/tags-api";

function Preview({ id, mimeType }: { id: string; mimeType: string | null }) {
  const url = documentsApi.fileUrl(id);
  if (mimeType === "application/pdf") return <iframe title="Preview" src={url} className="w-full h-[70vh] border rounded" />;
  if (mimeType?.startsWith("image/")) return <img src={url} alt="Preview" className="max-h-[70vh] rounded border" />;
  return (
    <p className="text-sm text-muted-foreground">
      No inline preview for this type.{" "}
      <a className="underline" href={documentsApi.fileUrl(id, true)}>
        Download
      </a>
    </p>
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
        className="rounded border bg-transparent p-2 text-sm"
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
      {document.categorySource === "auto" && <Badge variant="outline">Auto</Badge>}
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
        <Badge key={t.id} variant="secondary" className="flex items-center gap-1">
          {t.name}
          {t.auto && <span className="text-xs text-muted-foreground">(auto)</span>}
          <button type="button" aria-label={`Remove ${t.name}`} className="ml-1" onClick={() => removeTag.mutate(t.id)}>
            x
          </button>
        </Badge>
      ))}
      {available.length > 0 && (
        <select className="rounded border bg-transparent p-1 text-xs" value="" onChange={(e) => e.target.value && addTag.mutate(e.target.value)}>
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

  if (!document) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold break-all">{document.name}</h1>
          <p className="text-sm text-muted-foreground">
            {document.mimeType ?? "unknown type"} · {document.sizeBytes == null ? "" : formatBytes(document.sizeBytes)} · added {formatDate(document.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
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
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <CategoryPicker document={document} id={id} queryClient={queryClient} />
        <TagPicker document={document} id={id} queryClient={queryClient} />
      </div>

      <Preview id={id} mimeType={document.mimeType} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            Text
            <Badge variant={document.extractionStatus === "failed" ? "destructive" : "secondary"}>{document.extractionStatus}</Badge>
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
