import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, FileText, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { documentsApi, type DocumentRow, type EvaluationRow } from "@/lib/documents-api";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  processing: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  done: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

function StatusBadge({ label, status }: { label: string; status: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${STATUS_COLORS[status] ?? ""}`}>{label}</span>;
}

function EvalReasoning({ evaluations }: { evaluations: EvaluationRow[] }) {
  const applied = evaluations.filter((e) => e.outcome === "applied");
  if (applied.length === 0) return null;
  return (
    <div className="space-y-1">
      {applied.map((e) => (
        <div key={e.id} className="text-xs text-muted-foreground">
          <span className="font-medium">{e.targetType === "tag" ? "Tag" : "Category"}: {e.itemName}</span>
          {e.reasoning && <span className="ml-1">- {e.reasoning}</span>}
        </div>
      ))}
    </div>
  );
}

export function InboxCard({ document, onAccepted }: { document: DocumentRow; onAccepted?: () => void }) {
  const queryClient = useQueryClient();
  const { data: evaluations = [] } = useQuery({
    queryKey: ["evaluations", document.id],
    queryFn: () => documentsApi.listEvaluations(document.id),
    enabled: document.extractionStatus === "done",
  });

  const accept = useMutation({
    mutationFn: () => documentsApi.acceptTriage(document.id, !!document.suggestedTitle),
    onSuccess: () => {
      toast.success("Document filed");
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      onAccepted?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isProcessing = document.extractionStatus === "processing" || document.summaryStatus === "processing";
  const displayName = document.suggestedTitle ?? document.name;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Link to={`/documents/${document.id}`} className="truncate font-heading text-base underline-offset-2 hover:underline">
                {displayName}
              </Link>
            </div>
            {document.suggestedTitle && (
              <p className="mt-0.5 truncate pl-6 text-xs text-muted-foreground">
                Original: {document.name}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge label="Extract" status={document.extractionStatus} />
            <StatusBadge label="Summary" status={document.summaryStatus} />
          </div>
        </div>

        {document.summary && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{document.summary}</p>
        )}

        {isProcessing && !document.summary && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Processing...
          </div>
        )}

        {document.categoryPath && (
          <div className="flex items-center gap-1.5">
            <Badge variant="accent">{document.categoryPath}</Badge>
            <span className="text-[0.65rem] text-muted-foreground">(auto)</span>
          </div>
        )}

        {document.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {document.tags.map((tag) => (
              <Badge key={tag.id} variant="neutral" style={tag.color ? { borderColor: tag.color } : undefined}>
                {tag.name}
                {tag.auto && <span className="ml-1 text-[0.6rem] opacity-60">(auto)</span>}
              </Badge>
            ))}
          </div>
        )}

        <EvalReasoning evaluations={evaluations} />

        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={() => accept.mutate()} disabled={accept.isPending}>
            <Check className="mr-1 h-3.5 w-3.5" />
            {document.suggestedTitle ? "Accept with title" : "Accept"}
          </Button>
          <Link to={`/documents/${document.id}`}>
            <Button size="sm" variant="outline">
              <Eye className="mr-1 h-3.5 w-3.5" />
              View
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
