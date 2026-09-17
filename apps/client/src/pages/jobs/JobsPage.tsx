import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { jobsApi, type JobRow } from "@/lib/jobs-api";
import { formatDate } from "@/lib/format";

const FILTERS: { label: string; value?: JobRow["status"] }[] = [
  { label: "All" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Done", value: "done" },
  { label: "Failed", value: "failed" },
];

function statusVariant(status: JobRow["status"]) {
  if (status === "failed") return "destructive" as const;
  if (status === "done") return "accent2" as const;
  return "accent" as const;
}

export function JobsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JobRow["status"] | undefined>(undefined);
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs", status ?? "all"],
    queryFn: () => jobsApi.list(status),
    refetchInterval: (query) => (query.state.data?.some((j) => j.status === "pending" || j.status === "processing") ? 3000 : 15000),
  });
  const retry = useMutation({
    mutationFn: (id: string) => jobsApi.retry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Retry queued");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <h1 className="font-heading text-2xl">Jobs</h1>
      <div className="flex gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <Button key={f.label} size="sm" variant={f.value === status ? "default" : "outline"} onClick={() => setStatus(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs yet. Upload a document and its extraction shows up here.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Error</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id}>
                <TableCell>{j.type}</TableCell>
                <TableCell>
                  {j.payload.documentId ? (
                    <Link className="underline-offset-2 hover:underline" to={`/documents/${j.payload.documentId}`}>
                      {j.payload.documentId}
                    </Link>
                  ) : (
                    ""
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(j.status)}>{j.status}</Badge>
                </TableCell>
                <TableCell>{j.attempts}</TableCell>
                <TableCell>{formatDate(j.createdAt)}</TableCell>
                <TableCell className="max-w-md whitespace-pre-wrap break-words text-sm text-muted-foreground">{j.error ?? ""}</TableCell>
                <TableCell>
                  {j.status === "failed" && (
                    <Button size="sm" variant="outline" onClick={() => retry.mutate(j.id)} disabled={retry.isPending}>
                      Retry
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
