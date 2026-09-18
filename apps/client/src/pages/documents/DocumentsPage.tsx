import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { documentsApi, type DocumentListFilters } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";
import { categoriesApi, tagsApi } from "@/lib/tags-api";

const VIEW_LABELS: Record<string, string> = { inbox: "Inbox", needs_review: "Needs review" };

// The category filter needs an option for "no category assigned" but categoryId in the
// API only accepts real category ids, so this sentinel is resolved into a client-side
// filter instead of being sent to the server.
const UNCATEGORIZED_VALUE = "none";

function ColumnFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-full border border-input bg-secondary px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-foreground"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ActiveFilterBadge({ label, variant, onClear, clearLabel }: { label: string; variant: "accent" | "accent2"; onClear: () => void; clearLabel: string }) {
  return (
    <Badge variant={variant} className="gap-1 normal-case">
      {label}
      <button type="button" aria-label={clearLabel} onClick={onClear} className="opacity-70 hover:opacity-100">
        x
      </button>
    </Badge>
  );
}

export function DocumentsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const categoryParam = searchParams.get("categoryId") ?? "";
  const tagParam = searchParams.get("tagId") ?? "";
  const isUncategorized = categoryParam === UNCATEGORIZED_VALUE;

  const filters: DocumentListFilters = {
    categoryId: categoryParam && !isUncategorized ? categoryParam : undefined,
    tagId: tagParam || undefined,
    view: (searchParams.get("view") as DocumentListFilters["view"]) ?? "all",
  };
  const { data: rawDocuments = [], isLoading } = useQuery({
    queryKey: ["documents", filters],
    queryFn: () => documentsApi.list(filters),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.some((d) => d.extractionStatus === "pending" || d.extractionStatus === "processing") ? 3000 : false),
  });
  const documents = isUncategorized ? rawDocuments.filter((d) => d.categoryId === null) : rawDocuments;

  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });

  function setFilterParam(key: "categoryId" | "tagId", value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  const categoryFilterLabel = isUncategorized ? "None" : (categories.find((c) => c.id === categoryParam)?.name ?? null);
  const tagFilterLabel = tags.find((t) => t.id === tagParam)?.name ?? null;

  const filterLabel = filters.view && filters.view !== "all" ? VIEW_LABELS[filters.view] : null;
  const hasFilter = Boolean(filterLabel || categoryParam || tagParam);

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
              <TableHead>
                <div className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
                  <span>Category</span>
                  <ColumnFilter
                    label="Filter by category"
                    value={categoryParam}
                    onChange={(v) => setFilterParam("categoryId", v)}
                    options={[
                      { value: "", label: "All categories" },
                      { value: UNCATEGORIZED_VALUE, label: "None" },
                      ...categories.map((c) => ({ value: c.id, label: c.path })),
                    ]}
                  />
                  {categoryFilterLabel && (
                    <ActiveFilterBadge
                      label={categoryFilterLabel}
                      variant="accent"
                      clearLabel="Clear category filter"
                      onClear={() => setFilterParam("categoryId", "")}
                    />
                  )}
                </div>
              </TableHead>
              <TableHead>
                <div className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
                  <span>Tags</span>
                  <ColumnFilter
                    label="Filter by tags"
                    value={tagParam}
                    onChange={(v) => setFilterParam("tagId", v)}
                    options={[{ value: "", label: "All tags" }, ...tags.map((t) => ({ value: t.id, label: t.name }))]}
                  />
                  {tagFilterLabel && (
                    <ActiveFilterBadge label={tagFilterLabel} variant="accent2" clearLabel="Clear tag filter" onClear={() => setFilterParam("tagId", "")} />
                  )}
                </div>
              </TableHead>
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
                  {d.summary && <p className="text-xs text-muted-foreground line-clamp-1">{d.summary}</p>}
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
