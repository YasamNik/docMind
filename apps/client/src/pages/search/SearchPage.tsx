import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { savedSearchesApi } from "@/lib/saved-searches-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { searchApi, type SearchResult } from "@/lib/search-api";
import { storageApi } from "@/lib/storage-api";

const SOURCE_LABELS: Record<SearchResult["source"], string> = {
  vector: "vector",
  keyword: "keyword",
  hybrid: "hybrid",
};

const SOURCE_VARIANTS: Record<SearchResult["source"], "accent" | "accent2" | "neutral"> = {
  vector: "accent",
  keyword: "neutral",
  hybrid: "accent2",
};

function escapeRegExp(token: string) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatches(text: string, query: string) {
  const tokens = Array.from(new Set(query.trim().split(/\s+/).filter(Boolean)));
  if (tokens.length === 0) return text;
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, index) =>
    tokens.some((token) => token.toLowerCase() === part.toLowerCase()) ? (
      <strong key={index} className="font-semibold">
        {part}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function extractSnippet(text: string, query: string, maxLen = 200): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return text.slice(0, maxLen);
  const pattern = new RegExp(tokens.map(escapeRegExp).join("|"), "i");
  const match = pattern.exec(text);
  if (!match) return text.slice(0, maxLen);
  const start = Math.max(0, match.index - 80);
  const end = Math.min(text.length, match.index + match[0].length + 120);
  const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
  return snippet;
}

function ResultCard({ result, query, otherStorageLabel }: { result: SearchResult; query: string; otherStorageLabel: string | null }) {
  const snippet = extractSnippet(result.chunkText, query);
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2 md:flex-nowrap md:items-center">
          <Link to={`/documents/${result.documentId}`} className="font-heading text-base underline-offset-2 hover:underline">
            {result.documentName}
          </Link>
          <div className="flex items-center gap-2">
            {otherStorageLabel && <Badge variant="neutral">{otherStorageLabel}</Badge>}
            <Badge variant={SOURCE_VARIANTS[result.source]}>{SOURCE_LABELS[result.source]}</Badge>
          </div>
        </div>
        <p className="line-clamp-2 break-all text-sm text-muted-foreground">{highlightMatches(snippet, query)}</p>
      </CardContent>
    </Card>
  );
}

export function SearchPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const savedId = searchParams.get("saved");
  const { data: savedSearches = [] } = useQuery({ queryKey: ["saved-searches"], queryFn: savedSearchesApi.list });
  const savedSearch = savedId ? savedSearches.find((s) => s.id === savedId) : null;

  const [query, setQuery] = useState(savedSearch?.query ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(savedSearch?.query ?? "");

  useEffect(() => {
    if (savedSearch?.query) { setQuery(savedSearch.query); setDebouncedQuery(savedSearch.query); }
  }, [savedSearch?.query]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmedQuery = debouncedQuery.trim();
  const { data, isFetching } = useQuery({
    queryKey: ["search", trimmedQuery],
    queryFn: () => searchApi.search(trimmedQuery, 20),
    enabled: trimmedQuery.length > 0,
  });

  const results = data?.results ?? [];

  const { data: storageDrivers = [] } = useQuery({ queryKey: ["storage-drivers"], queryFn: () => storageApi.list() });
  const activeStorageId = storageDrivers.find((d) => d.active)?.id ?? null;
  // Search sees every storage, so a result held elsewhere still shows up here. The badge
  // is what tells the user why they cannot open it without switching storage first.
  function otherStorageLabel(storageDriver: string): string | null {
    if (storageDrivers.length === 0 || storageDriver === activeStorageId) return null;
    return storageDrivers.find((d) => d.id === storageDriver)?.label ?? storageDriver;
  }

  const reembed = useMutation({
    mutationFn: () => searchApi.reembedAll(),
    onSuccess: (result) => toast.success(`Queued ${result.count} document${result.count === 1 ? "" : "s"} for embedding`),
    onError: (e: Error) => toast.error(e.message),
  });

  const saveSearch = useMutation({
    mutationFn: () => {
      const name = window.prompt("Name for this saved search:");
      if (!name) throw new Error("Cancelled");
      return savedSearchesApi.create(name, trimmedQuery);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["saved-searches"] }); toast.success("Search saved"); },
    onError: (e: Error) => { if (e.message !== "Cancelled") toast.error(e.message); },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="font-heading text-2xl">Search</h1>
        <div className="flex flex-wrap gap-2">
          {trimmedQuery.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => saveSearch.mutate()} disabled={saveSearch.isPending}>
              Save search
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => reembed.mutate()} disabled={reembed.isPending}>
            {reembed.isPending ? "Embedding..." : "Embed all documents"}
          </Button>
        </div>
      </div>
      <Input
        autoFocus
        placeholder="Search your documents..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full md:max-w-xl"
      />
      {trimmedQuery.length === 0 ? (
        <p className="text-sm text-muted-foreground">Search your documents by keyword or meaning</p>
      ) : isFetching ? (
        <p className="text-sm text-muted-foreground">Searching...</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No results found for &quot;{trimmedQuery}&quot;</p>
      ) : (
        <div className="space-y-3">
          {results.map((result) => (
            <ResultCard
              key={`${result.documentId}-${result.chunkIndex}`}
              result={result}
              query={trimmedQuery}
              otherStorageLabel={otherStorageLabel(result.storageDriver)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
