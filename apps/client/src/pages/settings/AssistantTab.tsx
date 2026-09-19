import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { assistantApi, type InstructionVersion } from "@/lib/assistant-api";
import { formatReplacedAt } from "@/lib/format";

const QUERY_KEY = ["assistant-instructions"];

export function AssistantTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => assistantApi.instructions(),
  });

  const [draft, setDraft] = useState("");
  const loadedOnce = useRef(false);
  const [preview, setPreview] = useState<InstructionVersion | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<InstructionVersion | null>(null);

  useEffect(() => {
    if (data && !loadedOnce.current) {
      setDraft(data.body);
      loadedOnce.current = true;
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (body: string) => assistantApi.saveInstructions(body),
    onSuccess: (view) => {
      queryClient.setQueryData(QUERY_KEY, view);
      setDraft(view.body);
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const restore = useMutation({
    mutationFn: (replacedAt: string) => assistantApi.restoreInstructions(replacedAt),
    onSuccess: (view) => {
      queryClient.setQueryData(QUERY_KEY, view);
      setDraft(view.body);
      setPreview(null);
      setConfirmRestore(null);
      toast.success("Restored");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading your instructions...</p>;
  }

  const length = draft.length;
  const overCap = length > data.maxChars;
  const unchanged = draft === data.body;
  const isShippedDefault = draft === data.shippedDefault;

  let counterClass = "text-muted-foreground";
  if (overCap) counterClass = "text-destructive";
  else if (length >= data.warnChars) counterClass = "text-yellow-700 dark:text-yellow-400";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Assistant</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This document goes to the assistant with every message, in the app and in Telegram, so keep it
            short. It changes how the assistant talks and what it assumes. It cannot give the assistant new
            abilities or remove a confirmation, whatever it says.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="assistant-instructions">Your instructions</Label>
            <textarea
              id="assistant-instructions"
              className="min-h-64 w-full rounded-[1.75rem] border bg-secondary px-4 py-3 font-mono text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-sm ${counterClass}`}>
              {length.toLocaleString()} / {data.maxChars.toLocaleString()} characters
            </p>
            {overCap && (
              <p className="text-sm text-destructive">
                Too long to save. Shorten it by {(length - data.maxChars).toLocaleString()} characters.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save.mutate(draft)} disabled={unchanged || overCap || save.isPending}>
              {save.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDraft(data.shippedDefault)}
              disabled={isShippedDefault}
            >
              Reset to the shipped default
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Reset only fills the editor with the shipped default. It does not change anything until you save,
            and saving it is an ordinary save, so what you have now becomes a version you can restore later.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Previous versions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No previous versions yet. The last 20 versions are kept.</p>
          ) : (
            <>
              {data.history.map((version) => (
                <button
                  key={version.replacedAt}
                  type="button"
                  onClick={() => setPreview(version)}
                  className="w-full rounded-lg border border-border p-3 text-left text-sm hover:bg-secondary"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>In use until {formatReplacedAt(version.replacedAt)}</span>
                    <span className="text-xs text-muted-foreground">
                      {version.body.length.toLocaleString()} characters
                    </span>
                  </div>
                </button>
              ))}
              <p className="text-xs text-muted-foreground">The last 20 versions are kept.</p>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{preview && `In use until ${formatReplacedAt(preview.replacedAt)}`}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-secondary p-3 text-xs">
            {preview?.body}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              Close
            </Button>
            <Button onClick={() => preview && setConfirmRestore(preview)}>Restore this version</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRestore !== null} onOpenChange={(open) => !open && setConfirmRestore(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this version?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">The text you have now is kept in the history.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestore(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => confirmRestore && restore.mutate(confirmRestore.replacedAt)}
              disabled={restore.isPending}
            >
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
