import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { DATE_FILTER_OPTIONS, dateFilterBadgeLabel, matchesDateFilter, type DateFilterValue } from "@/lib/date-filter";
import { documentsApi, type DocumentListFilters, type DocumentRow } from "@/lib/documents-api";
import { formatBytes, formatDate, formatDocumentDate } from "@/lib/format";
import { categoriesApi, tagsApi } from "@/lib/tags-api";

const VIEW_LABELS: Record<string, string> = { needs_review: "Needs review" };

const MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/jpg": "JPG",
  "text/plain": "Text",
  "text/csv": "CSV",
  "text/markdown": "Markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "application/msword": "Word",
  "application/vnd.ms-excel": "Excel",
  "application/vnd.ms-powerpoint": "PowerPoint",
};

function friendlyMime(mime: string | null): string {
  if (!mime) return "-";
  return MIME_LABELS[mime] ?? mime.split("/").pop() ?? mime;
}

type SortKey = "name" | "category" | "tags" | "type" | "size" | "createdAt" | "documentDate";
type SortDir = "asc" | "desc";

function sortDocuments(docs: DocumentRow[], key: SortKey, dir: SortDir): DocumentRow[] {
  const sorted = [...docs].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "name": cmp = a.name.localeCompare(b.name); break;
      case "category": cmp = (a.categoryPath ?? "").localeCompare(b.categoryPath ?? ""); break;
      case "tags": cmp = (a.tags[0]?.name ?? "").localeCompare(b.tags[0]?.name ?? ""); break;
      case "type": cmp = (a.mimeType ?? "").localeCompare(b.mimeType ?? ""); break;
      case "size": cmp = (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0); break;
      case "createdAt": cmp = a.createdAt.localeCompare(b.createdAt); break;
      case "documentDate": cmp = (a.documentDate ?? "").localeCompare(b.documentDate ?? ""); break;
    }
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

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

function ActiveFilterBadge({
  label,
  variant,
  onClear,
  clearLabel,
}: {
  label: string;
  variant: "accent" | "accent2" | "neutral";
  onClear: () => void;
  clearLabel: string;
}) {
  return (
    <Badge variant={variant} className="gap-1 normal-case">
      {label}
      <button type="button" aria-label={clearLabel} onClick={onClear} className="opacity-70 hover:opacity-100">
        x
      </button>
    </Badge>
  );
}

// Reads a DateFilterValue split across three query params (<prefix>Preset, <prefix>Start,
// <prefix>End) so the Added and Doc Date column filters can share the URL without clashing.
function readDateFilter(searchParams: URLSearchParams, prefix: string): DateFilterValue {
  const preset = (searchParams.get(`${prefix}Preset`) as DateFilterValue["preset"]) || "all";
  return {
    preset,
    start: searchParams.get(`${prefix}Start`) ?? undefined,
    end: searchParams.get(`${prefix}End`) ?? undefined,
  };
}

function DateColumnFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
}) {
  return (
    <>
      <ColumnFilter
        label={label}
        value={value.preset}
        onChange={(preset) => onChange({ preset: preset as DateFilterValue["preset"] })}
        options={DATE_FILTER_OPTIONS}
      />
      {value.preset === "custom" && (
        <span className="flex items-center gap-1">
          <input
            type="date"
            aria-label={`${label}, start date`}
            value={value.start ?? ""}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
            className="rounded-full border border-input bg-secondary px-2 py-0.5 text-[10px] normal-case tracking-normal text-foreground"
          />
          <span className="text-[10px] text-muted-foreground">to</span>
          <input
            type="date"
            aria-label={`${label}, end date`}
            value={value.end ?? ""}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
            className="rounded-full border border-input bg-secondary px-2 py-0.5 text-[10px] normal-case tracking-normal text-foreground"
          />
        </span>
      )}
    </>
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
  const addedFilter = readDateFilter(searchParams, "added");
  const docDateFilter = readDateFilter(searchParams, "docDate");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const filtered = rawDocuments
    .filter((d) => !isUncategorized || d.categoryId === null)
    .filter((d) => matchesDateFilter(d.createdAt, addedFilter))
    .filter((d) => matchesDateFilter(d.documentDate, docDateFilter));
  const documents = sortDocuments(filtered, sortKey, sortDir);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }
  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });

  function setFilterParam(key: "categoryId" | "tagId", value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  function setDateFilter(prefix: string, value: DateFilterValue) {
    const next = new URLSearchParams(searchParams);
    if (value.preset === "all") next.delete(`${prefix}Preset`);
    else next.set(`${prefix}Preset`, value.preset);
    if (value.preset === "custom" && value.start) next.set(`${prefix}Start`, value.start);
    else next.delete(`${prefix}Start`);
    if (value.preset === "custom" && value.end) next.set(`${prefix}End`, value.end);
    else next.delete(`${prefix}End`);
    setSearchParams(next);
  }

  const categoryFilterLabel = isUncategorized ? "None" : (categories.find((c) => c.id === categoryParam)?.name ?? null);
  const tagFilterLabel = tags.find((t) => t.id === tagParam)?.name ?? null;
  const addedFilterLabel = dateFilterBadgeLabel(addedFilter);
  const docDateFilterLabel = dateFilterBadgeLabel(docDateFilter);

  const filterLabel = filters.view && filters.view !== "all" ? VIEW_LABELS[filters.view] : null;
  const hasFilter = Boolean(filterLabel || categoryParam || tagParam || addedFilterLabel || docDateFilterLabel);

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
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("name")}>Name{sortIndicator("name")}</TableHead>
              <TableHead>
                <div className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
                  <span className="cursor-pointer select-none" onClick={() => toggleSort("category")}>Category{sortIndicator("category")}</span>
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
                  <span className="cursor-pointer select-none" onClick={() => toggleSort("tags")}>Tags{sortIndicator("tags")}</span>
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
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("type")}>Type{sortIndicator("type")}</TableHead>
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("size")}>Size{sortIndicator("size")}</TableHead>
              <TableHead>
                <div className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
                  <span className="cursor-pointer select-none" onClick={() => toggleSort("createdAt")}>Added{sortIndicator("createdAt")}</span>
                  <DateColumnFilter label="Filter by added date" value={addedFilter} onChange={(v) => setDateFilter("added", v)} />
                  {addedFilterLabel && (
                    <ActiveFilterBadge
                      label={addedFilterLabel}
                      variant="neutral"
                      clearLabel="Clear added date filter"
                      onClear={() => setDateFilter("added", { preset: "all" })}
                    />
                  )}
                </div>
              </TableHead>
              <TableHead>
                <div className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
                  <span className="cursor-pointer select-none" onClick={() => toggleSort("documentDate")}>Doc Date{sortIndicator("documentDate")}</span>
                  <DateColumnFilter label="Filter by document date" value={docDateFilter} onChange={(v) => setDateFilter("docDate", v)} />
                  {docDateFilterLabel && (
                    <ActiveFilterBadge
                      label={docDateFilterLabel}
                      variant="neutral"
                      clearLabel="Clear document date filter"
                      onClear={() => setDateFilter("docDate", { preset: "all" })}
                    />
                  )}
                </div>
              </TableHead>
              <TableHead>Text</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="max-w-[260px]">
                  <Link to={`/documents/${d.id}`} className="block truncate underline-offset-2 hover:underline" title={d.name}>
                    {d.name}
                  </Link>
                  {d.summary && <p className="truncate text-xs text-muted-foreground" title={d.summary}>{d.summary}</p>}
                </TableCell>
                <TableCell className="max-w-[120px] truncate text-muted-foreground" title={d.categoryPath ?? undefined}>{d.categoryPath ?? "None"}</TableCell>
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
                <TableCell className="text-muted-foreground" title={d.mimeType ?? undefined}>{friendlyMime(d.mimeType)}</TableCell>
                <TableCell>{d.sizeBytes == null ? "" : formatBytes(d.sizeBytes)}</TableCell>
                <TableCell>{formatDate(d.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDocumentDate(d.documentDate)}</TableCell>
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
