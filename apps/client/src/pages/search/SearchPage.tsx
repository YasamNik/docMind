import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { searchApi, type SearchResult } from "@/lib/search-api";

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

function ResultCard({ result, query }: { result: SearchResult; query: string }) {
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Link to={`/documents/${result.documentId}`} className="font-heading text-base underline-offset-2 hover:underline">
            {result.documentName}
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary">{Math.round(result.score * 100)}%</Badge>
            <Badge variant={SOURCE_VARIANTS[result.source]}>{SOURCE_LABELS[result.source]}</Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{highlightMatches(result.chunkText, query)}</p>
      </CardContent>
    </Card>
  );
}

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

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

  const reembed = useMutation({
    mutationFn: () => searchApi.reembedAll(),
    onSuccess: (result) => toast.success(`Queued ${result.count} document${result.count === 1 ? "" : "s"} for embedding`),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl">Search</h1>
        <Button size="sm" variant="outline" onClick={() => reembed.mutate()} disabled={reembed.isPending}>
          {reembed.isPending ? "Embedding..." : "Embed all documents"}
        </Button>
      </div>
      <Input
        autoFocus
        placeholder="Search your documents..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-xl"
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
            <ResultCard key={`${result.documentId}-${result.chunkIndex}`} result={result} query={trimmedQuery} />
          ))}
        </div>
      )}
    </div>
  );
}
