import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { documentsApi, type DocumentListFilters } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";

const VIEW_LABELS: Record<string, string> = { inbox: "Inbox", needs_review: "Needs review" };

export function DocumentsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const filters: DocumentListFilters = {
    categoryId: searchParams.get("categoryId") ?? undefined,
    tagId: searchParams.get("tagId") ?? undefined,
    view: (searchParams.get("view") as DocumentListFilters["view"]) ?? "all",
  };
  const { data: documents = [], isLoading } = useQuery({
    queryKey: ["documents", filters],
    queryFn: () => documentsApi.list(filters),
    refetchInterval: (query) => (query.state.data?.some((d) => d.extractionStatus === "pending" || d.extractionStatus === "processing") ? 3000 : false),
  });

  const filterLabel = filters.view && filters.view !== "all" ? VIEW_LABELS[filters.view] : null;
  const hasFilter = Boolean(filterLabel || filters.categoryId || filters.tagId);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-2xl">{filterLabel ?? "Documents"}</h1>
        {hasFilter && (
          <Link to="/documents" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Clear filter
          </Link>
        )}
      </div>
      <UploadDropzone onUploaded={() => queryClient.invalidateQueries({ queryKey: ["documents"] })} />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents match this view.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Text</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link to={`/documents/${d.id}`} className="underline-offset-2 hover:underline">
                    {d.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{d.categoryPath ?? "None"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {d.tags.map((t) => (
                      <Badge key={t.id} variant={t.auto ? "accent2" : "accent"} className="gap-1">
                        {t.name}
                        {t.auto && <span className="text-xs opacity-70">(auto)</span>}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{d.mimeType ?? "unknown"}</TableCell>
                <TableCell>{d.sizeBytes == null ? "" : formatBytes(d.sizeBytes)}</TableCell>
                <TableCell>{formatDate(d.createdAt)}</TableCell>
                <TableCell>
                  <Badge variant={d.extractionStatus === "failed" ? "destructive" : "secondary"}>{d.extractionStatus}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
