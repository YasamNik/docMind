import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { documentsApi } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";

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

export function DocumentDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: document } = useQuery({ queryKey: ["documents", id], queryFn: () => documentsApi.get(id) });
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

      <Preview id={id} mimeType={document.mimeType} />

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
