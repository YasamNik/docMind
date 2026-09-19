import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Inbox } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { InboxCard } from "@/components/documents/InboxCard";
import { documentsApi } from "@/lib/documents-api";

export function InboxPage() {
  const queryClient = useQueryClient();
  const { data: documents = [], isFetching } = useQuery({
    queryKey: ["documents", "inbox"],
    queryFn: () => documentsApi.list({ view: "inbox" }),
    refetchInterval: (query) => {
      const docs = query.state.data;
      if (!docs || docs.length === 0) return false;
      const anyProcessing = docs.some((d) => d.extractionStatus === "processing" || d.summaryStatus === "processing");
      return anyProcessing ? 5000 : false;
    },
  });

  const batchAccept = useMutation({
    mutationFn: () => {
      const readyIds = documents
        .filter((d) => d.extractionStatus !== "processing" && d.summaryStatus !== "processing")
        .map((d) => d.id);
      return documentsApi.acceptTriageBatch(readyIds);
    },
    onSuccess: (result) => {
      toast.success(`Filed ${result.updatedCount} document${result.updatedCount === 1 ? "" : "s"}`);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const readyCount = documents.filter((d) => d.extractionStatus !== "processing" && d.summaryStatus !== "processing").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-heading text-2xl">Inbox</h1>
        {readyCount > 1 && (
          <Button size="sm" variant="outline" onClick={() => batchAccept.mutate()} disabled={batchAccept.isPending}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" />
            Accept all ready ({readyCount})
          </Button>
        )}
      </div>

      {documents.length === 0 && !isFetching ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">All caught up. No new documents to review.</p>
          <Link to="/documents" className="text-sm underline underline-offset-2">
            View all documents
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <InboxCard
              key={doc.id}
              document={doc}
              onAccepted={() => queryClient.invalidateQueries({ queryKey: ["documents"] })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
