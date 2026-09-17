import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { documentsApi } from "@/lib/documents-api";
import { sortApi, type DryRunResult } from "@/lib/sort-api";

export function DryRunPanel({
  targetType,
  name,
  description,
  threshold,
}: {
  targetType: "tag" | "category";
  name: string;
  description: string;
  threshold: number;
}) {
  const { data: documents = [] } = useQuery({ queryKey: ["documents", { view: "all" }], queryFn: () => documentsApi.list() });
  const [documentId, setDocumentId] = useState("");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const test = useMutation({
    // Posts the form's current in-memory values, not the saved row, so
    // testing an edit before saving reflects the edit.
    mutationFn: () => sortApi.dryRun({ documentId, targetType, name, description, threshold }),
    onSuccess: (r) => setResult(r),
  });

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium uppercase text-muted-foreground">Test on a document</p>
      <div className="flex items-center gap-2">
        <select
          className="flex-1 rounded border bg-transparent p-2 text-sm"
          value={documentId}
          onChange={(e) => {
            setDocumentId(e.target.value);
            setResult(null);
          }}
        >
          <option value="">Choose a document</option>
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={!documentId || !name.trim() || test.isPending} onClick={() => test.mutate()}>
          Test
        </Button>
      </div>
      {result && (
        <p className="text-xs">
          {result.wouldApply ? "Would apply" : "Would not apply"} (confidence {Math.round(result.confidence * 100)}%): {result.reasoning}
        </p>
      )}
    </div>
  );
}
