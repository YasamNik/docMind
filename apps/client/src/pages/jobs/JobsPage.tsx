import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { jobsApi, type JobRow } from "@/lib/jobs-api";
import { formatDate } from "@/lib/format";
import { useIsMobile } from "@/lib/use-media-query";

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

// One card per job below the breakpoint. The seven table columns fold into a heading line,
// a status badge, a quiet line of the facts that matter, and the error text a failed job
// needs to explain itself, with the retry button the table row already carried.
function JobCard({ job, onRetry, retryPending }: { job: JobRow; onRetry: () => void; retryPending: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="font-heading text-base">{job.type}</p>
          <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
        </div>
        {job.payload.documentId && (
          <Link className="block truncate text-xs underline-offset-2 hover:underline" to={`/documents/${job.payload.documentId}`}>
            {job.payload.documentId}
          </Link>
        )}
        <p className="text-xs text-muted-foreground">
          Attempt {job.attempts} · {formatDate(job.createdAt)}
        </p>
        {job.error && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{job.error}</p>}
        {job.status === "failed" && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retryPending}>
            Retry
          </Button>
        )}
      </CardContent>
    </Card>
  );
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
  const isMobile = useIsMobile();

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
      ) : isMobile ? (
        <div className="space-y-3">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} onRetry={() => retry.mutate(j.id)} retryPending={retry.isPending} />
          ))}
        </div>
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
