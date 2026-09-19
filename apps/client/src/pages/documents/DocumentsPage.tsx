import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { DATE_FILTER_OPTIONS, dateFilterBadgeLabel, matchesDateFilter, type DateFilterValue } from "@/lib/date-filter";
import { documentsApi, type DocumentListFilters, type DocumentRow } from "@/lib/documents-api";
import { formatBytes, formatDate, formatDocumentDate } from "@/lib/format";
import { storageApi } from "@/lib/storage-api";
import { categoriesApi, tagsApi } from "@/lib/tags-api";
import { useIsMobile } from "@/lib/use-media-query";

const VIEW_LABELS: Record<string, string> = { needs_review: "Needs review", trash: "Trash" };

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

type SortKey = "name" | "category" | "tags" | "type" | "size" | "createdAt" | "documentDate" | "expiryDate";

// Same words as the table headers, so the phone control reads like the same feature and
// not a second one that happens to do the same thing.
const SORT_FIELD_LABELS: Record<SortKey, string> = {
  name: "Name",
  category: "Category",
  tags: "Tags",
  expiryDate: "Exp. Date",
  type: "Type",
  size: "Size",
  createdAt: "Added",
  documentDate: "Doc Date",
};

// The one extracted field the library shows directly. Everything a document knows about
// expiry lives in the expiryDate smart field, so the column reads it from there.
function expiryOf(doc: DocumentRow): string | null {
  return doc.fields.find((f) => f.key === "expiryDate")?.valueDate ?? null;
}

// Compared as YYYY-MM-DD strings against today in the viewer's own timezone, so a
// document does not read as expired several hours early or late.
function isExpired(value: string | null): boolean {
  if (!value) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return value < today;
}
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
      case "expiryDate": cmp = (expiryOf(a) ?? "").localeCompare(expiryOf(b) ?? ""); break;
    }
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function TrashActions({ documentId, queryClient }: { documentId: string; queryClient: ReturnType<typeof useQueryClient> }) {
  const restore = useMutation({
    mutationFn: () => documentsApi.restore(documentId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["documents"] }); toast.success("Restored"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const purge = useMutation({
    mutationFn: () => documentsApi.purge(documentId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["documents"] }); toast.success("Permanently deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="outline" onClick={() => restore.mutate()} disabled={restore.isPending}>Restore</Button>
      <Button size="sm" variant="destructive" onClick={() => purge.mutate()} disabled={purge.isPending}>Delete</Button>
    </div>
  );
}

// The category filter needs an option for "no category assigned" but categoryId in the
// API only accepts real category ids, so this sentinel is resolved into a client-side
// filter instead of being sent to the server.
const UNCATEGORIZED_VALUE = "none";

// The header dropdown is a small pill meant to sit inline with a column title. The phone
// control below the breakpoint reuses the same options and the same onChange, only sized
// for a thumb, so the two never drift into different filter behavior.
function ColumnFilter({
  label,
  value,
  onChange,
  options,
  size = "sm",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  size?: "sm" | "lg";
}) {
  const className =
    size === "lg"
      ? "min-h-11 w-full rounded-2xl border border-input bg-background px-3 text-base text-foreground"
      : "rounded-full border border-input bg-secondary px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-foreground";
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
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
  size = "sm",
}: {
  label: string;
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
  size?: "sm" | "lg";
}) {
  const inputClassName =
    size === "lg"
      ? "min-h-11 flex-1 rounded-2xl border border-input bg-background px-3 text-base text-foreground"
      : "rounded-full border border-input bg-secondary px-2 py-0.5 text-[10px] normal-case tracking-normal text-foreground";
  return (
    <>
      <ColumnFilter
        label={label}
        value={value.preset}
        onChange={(preset) => onChange({ preset: preset as DateFilterValue["preset"] })}
        options={DATE_FILTER_OPTIONS}
        size={size}
      />
      {value.preset === "custom" && (
        <span className={size === "lg" ? "flex items-center gap-2" : "flex items-center gap-1"}>
          <input
            type="date"
            aria-label={`${label}, start date`}
            value={value.start ?? ""}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
            className={inputClassName}
          />
          <span className={size === "lg" ? "text-sm text-muted-foreground" : "text-[10px] text-muted-foreground"}>to</span>
          <input
            type="date"
            aria-label={`${label}, end date`}
            value={value.end ?? ""}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
            className={inputClassName}
          />
        </span>
      )}
    </>
  );
}

// Column sorting and the header filter dropdowns live in the table headers, and a phone
// card list has no headers. This is where both move on a phone: one control that shows
// what sort and what filters are active, and opens to the same pickers the headers offer.
function SortFilterBar({
  sortKey,
  sortDir,
  onSortKeyChange,
  onToggleDirection,
  categoryParam,
  onCategoryChange,
  categoryOptions,
  tagParam,
  onTagChange,
  tagOptions,
  addedFilter,
  onAddedFilterChange,
  docDateFilter,
  onDocDateFilterChange,
  categoryFilterLabel,
  onClearCategory,
  tagFilterLabel,
  onClearTag,
  addedFilterLabel,
  onClearAdded,
  docDateFilterLabel,
  onClearDocDate,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSortKeyChange: (key: SortKey) => void;
  onToggleDirection: () => void;
  categoryParam: string;
  onCategoryChange: (value: string) => void;
  categoryOptions: { value: string; label: string }[];
  tagParam: string;
  onTagChange: (value: string) => void;
  tagOptions: { value: string; label: string }[];
  addedFilter: DateFilterValue;
  onAddedFilterChange: (value: DateFilterValue) => void;
  docDateFilter: DateFilterValue;
  onDocDateFilterChange: (value: DateFilterValue) => void;
  categoryFilterLabel: string | null;
  onClearCategory: () => void;
  tagFilterLabel: string | null;
  onClearTag: () => void;
  addedFilterLabel: string | null;
  onClearAdded: () => void;
  docDateFilterLabel: string | null;
  onClearDocDate: () => void;
}) {
  const activeFilterCount = [categoryFilterLabel, tagFilterLabel, addedFilterLabel, docDateFilterLabel].filter(Boolean).length;
  return (
    <div className="space-y-2 md:hidden">
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {categoryFilterLabel && (
            <ActiveFilterBadge label={categoryFilterLabel} variant="accent" clearLabel="Clear category filter" onClear={onClearCategory} />
          )}
          {tagFilterLabel && <ActiveFilterBadge label={tagFilterLabel} variant="accent2" clearLabel="Clear tag filter" onClear={onClearTag} />}
          {addedFilterLabel && (
            <ActiveFilterBadge label={addedFilterLabel} variant="neutral" clearLabel="Clear added date filter" onClear={onClearAdded} />
          )}
          {docDateFilterLabel && (
            <ActiveFilterBadge label={docDateFilterLabel} variant="neutral" clearLabel="Clear document date filter" onClear={onClearDocDate} />
          )}
        </div>
      )}
      <details className="rounded-2xl border border-input bg-card">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 text-sm font-medium">
          <span>Sort and filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {SORT_FIELD_LABELS[sortKey]} {sortDir === "asc" ? "▲" : "▼"}
          </span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-input p-4">
          <div className="flex items-center gap-2">
            <select
              aria-label="Sort by"
              value={sortKey}
              onChange={(e) => onSortKeyChange(e.target.value as SortKey)}
              className="min-h-11 flex-1 rounded-2xl border border-input bg-background px-3 text-base text-foreground"
            >
              {(Object.keys(SORT_FIELD_LABELS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_FIELD_LABELS[key]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onToggleDirection}
              aria-label={`Sort direction, currently ${sortDir === "asc" ? "ascending" : "descending"}`}
              className="min-h-11 shrink-0 rounded-2xl border border-input px-3 text-sm text-foreground"
            >
              {sortDir === "asc" ? "Ascending" : "Descending"}
            </button>
          </div>
          <ColumnFilter label="Filter by category" value={categoryParam} onChange={onCategoryChange} options={categoryOptions} size="lg" />
          <ColumnFilter label="Filter by tags" value={tagParam} onChange={onTagChange} options={tagOptions} size="lg" />
          <DateColumnFilter label="Filter by added date" value={addedFilter} onChange={onAddedFilterChange} size="lg" />
          <DateColumnFilter label="Filter by document date" value={docDateFilter} onChange={onDocDateFilterChange} size="lg" />
        </div>
      </details>
    </div>
  );
}

// One card per document below the breakpoint: the name is the heading and stays the link
// to the document, category and tags sit under it as chips, and the facts that matter on
// a quiet line. Selection stays reachable as a checkbox, same state as the desktop table.
function DocumentCard({
  document: d,
  selected,
  onToggleSelect,
  showTrashActions,
  queryClient,
}: {
  document: DocumentRow;
  selected: boolean;
  onToggleSelect: () => void;
  showTrashActions: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const expiry = expiryOf(d);
  const expired = isExpired(expiry);
  return (
    <Card>
      <CardContent className="flex items-start gap-3">
        <label className="flex h-11 w-11 shrink-0 items-center justify-center">
          <span className="sr-only">Select {d.name}</span>
          <input type="checkbox" className="h-5 w-5" checked={selected} onChange={onToggleSelect} />
        </label>
        <Link to={`/documents/${d.id}`} className="min-w-0 flex-1 space-y-1.5">
          <p className="truncate font-heading text-base" title={d.name}>
            {d.name}
          </p>
          {(d.categoryPath || d.tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {d.categoryPath && <Badge variant="accent">{d.categoryPath}</Badge>}
              {d.tags.map((t) => (
                <Badge key={t.id} variant={t.auto ? "accent2" : "accent"} className="gap-1">
                  {t.name}
                  {t.auto && <span className="text-xs opacity-70">(auto)</span>}
                </Badge>
              ))}
            </div>
          )}
          <p className={expired ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
            Added {formatDate(d.createdAt)}
            {d.sizeBytes != null && <> · {formatBytes(d.sizeBytes)}</>}
            {expiry && <> · Expires {formatDocumentDate(expiry)}</>}
            {expired && <span className="sr-only"> (expired)</span>}
          </p>
        </Link>
        {showTrashActions && (
          <div className="shrink-0">
            <TrashActions documentId={d.id} queryClient={queryClient} />
          </div>
        )}
      </CardContent>
    </Card>
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
  function setSortField(key: SortKey) {
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  }
  function toggleSortDirection() {
    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
  }

  const isMobile = useIsMobile();

  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });
  const { data: storageDrivers = [] } = useQuery({ queryKey: ["storage-drivers"], queryFn: () => storageApi.list() });
  const activeStorage = storageDrivers.find((d) => d.active) ?? null;
  const otherStorageDocumentCount = storageDrivers.filter((d) => !d.active).reduce((sum, d) => sum + d.documentCount, 0);

  const selectedIds = [...selected];
  const invalidateAndClear = () => { queryClient.invalidateQueries({ queryKey: ["documents"] }); setSelected(new Set()); };
  const bulkDelete = useMutation({ mutationFn: () => documentsApi.bulkDelete(selectedIds), onSuccess: (r) => { invalidateAndClear(); toast.success(`Moved ${r.count} to trash`); }, onError: (e: Error) => toast.error(e.message) });
  const bulkTag = useMutation({ mutationFn: ({ tagId, action }: { tagId: string; action: "add" | "remove" }) => documentsApi.bulkTag(selectedIds, tagId, action), onSuccess: () => { invalidateAndClear(); toast.success("Tags updated"); }, onError: (e: Error) => toast.error(e.message) });
  const bulkCategory = useMutation({ mutationFn: (categoryId: string | null) => documentsApi.bulkCategory(selectedIds, categoryId), onSuccess: () => { invalidateAndClear(); toast.success("Category updated"); }, onError: (e: Error) => toast.error(e.message) });
  const bulkSort = useMutation({ mutationFn: () => documentsApi.bulkSort(selectedIds), onSuccess: () => { invalidateAndClear(); toast.success("Sorting queued"); }, onError: (e: Error) => toast.error(e.message) });

  function toggleSelect(id: string) { setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function toggleAll() { if (selected.size === documents.length) setSelected(new Set()); else setSelected(new Set(documents.map((d) => d.id))); }

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
      {activeStorage && (
        <p className="text-sm text-muted-foreground">
          Showing documents on {activeStorage.label}
          {otherStorageDocumentCount > 0 && (
            <> · {otherStorageDocumentCount} document{otherStorageDocumentCount === 1 ? "" : "s"} on other storages</>
          )}
        </p>
      )}
      <UploadDropzone onUploaded={() => queryClient.invalidateQueries({ queryKey: ["documents"] })} />
      {selected.size > 0 && filters.view !== "trash" && (
        <div className="flex flex-wrap items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <select
            className="rounded-full border border-input bg-secondary px-2 py-1 text-xs"
            defaultValue=""
            onChange={(e) => { if (e.target.value) bulkTag.mutate({ tagId: e.target.value, action: "add" }); e.target.value = ""; }}
          >
            <option value="" disabled>Add tag...</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select
            className="rounded-full border border-input bg-secondary px-2 py-1 text-xs"
            defaultValue=""
            onChange={(e) => { bulkCategory.mutate(e.target.value || null); e.target.value = ""; }}
          >
            <option value="" disabled>Set category...</option>
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={() => bulkSort.mutate()} disabled={bulkSort.isPending}>Re-evaluate</Button>
          <Button size="sm" variant="destructive" onClick={() => bulkDelete.mutate()} disabled={bulkDelete.isPending}>Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents match this view.</p>
      ) : isMobile ? (
        <div className="space-y-3">
          <SortFilterBar
            sortKey={sortKey}
            sortDir={sortDir}
            onSortKeyChange={setSortField}
            onToggleDirection={toggleSortDirection}
            categoryParam={categoryParam}
            onCategoryChange={(v) => setFilterParam("categoryId", v)}
            categoryOptions={[
              { value: "", label: "All categories" },
              { value: UNCATEGORIZED_VALUE, label: "None" },
              ...categories.map((c) => ({ value: c.id, label: c.path })),
            ]}
            tagParam={tagParam}
            onTagChange={(v) => setFilterParam("tagId", v)}
            tagOptions={[{ value: "", label: "All tags" }, ...tags.map((t) => ({ value: t.id, label: t.name }))]}
            addedFilter={addedFilter}
            onAddedFilterChange={(v) => setDateFilter("added", v)}
            docDateFilter={docDateFilter}
            onDocDateFilterChange={(v) => setDateFilter("docDate", v)}
            categoryFilterLabel={categoryFilterLabel}
            onClearCategory={() => setFilterParam("categoryId", "")}
            tagFilterLabel={tagFilterLabel}
            onClearTag={() => setFilterParam("tagId", "")}
            addedFilterLabel={addedFilterLabel}
            onClearAdded={() => setDateFilter("added", { preset: "all" })}
            docDateFilterLabel={docDateFilterLabel}
            onClearDocDate={() => setDateFilter("docDate", { preset: "all" })}
          />
          {documents.map((d) => (
            <DocumentCard
              key={d.id}
              document={d}
              selected={selected.has(d.id)}
              onToggleSelect={() => toggleSelect(d.id)}
              showTrashActions={filters.view === "trash"}
              queryClient={queryClient}
            />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input type="checkbox" checked={documents.length > 0 && selected.size === documents.length} onChange={toggleAll} />
              </TableHead>
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
              <TableHead>
                <div className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
                  <span className="cursor-pointer select-none" onClick={() => toggleSort("expiryDate")}>Exp. Date{sortIndicator("expiryDate")}</span>
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
              {filters.view === "trash" && <TableHead>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="w-8">
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} />
                </TableCell>
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
                <TableCell className={isExpired(expiryOf(d)) ? "font-medium text-destructive" : "text-muted-foreground"}>
                  {formatDocumentDate(expiryOf(d))}
                  {isExpired(expiryOf(d)) && <span className="sr-only"> (expired)</span>}
                </TableCell>
                <TableCell className="text-muted-foreground" title={d.mimeType ?? undefined}>{friendlyMime(d.mimeType)}</TableCell>
                <TableCell>{d.sizeBytes == null ? "" : formatBytes(d.sizeBytes)}</TableCell>
                <TableCell>{formatDate(d.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDocumentDate(d.documentDate)}</TableCell>
                <TableCell>
                  <Badge variant={d.extractionStatus === "failed" ? "destructive" : "secondary"}>{d.extractionStatus}</Badge>
                </TableCell>
                {filters.view === "trash" && (
                  <TableCell>
                    <TrashActions documentId={d.id} queryClient={queryClient} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
