import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { budgetApi, MAX_RECEIPT_PAGES, type BudgetReceiptWithItems } from "@/lib/budget-api";
import { documentsApi } from "@/lib/documents-api";

// Android backgrounds the tab for the camera intent, and Chrome sometimes reloads the
// page on return instead of resuming it, which wipes any state held only in memory. The
// ids of pages that already finished uploading are kept here so a reload mid capture
// restores the receipt in progress instead of silently dropping it. A page still
// uploading or failed when the reload happens has no file left to resume; it is dropped
// and the user retakes it.
const STORAGE_KEY = "docmind.captureSheet.documentIds";

type StagedPage =
  | { localId: string; status: "uploading"; url: string; file: File }
  | { localId: string; status: "error"; url: string; file: File; error: string }
  | { localId: string; status: "done"; url: string; documentId: string };

let nextLocalId = 0;

function readPersistedIds(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function persistDonePages(pages: StagedPage[]) {
  const ids = pages.filter((page) => page.status === "done").map((page) => page.documentId);
  if (ids.length === 0) sessionStorage.removeItem(STORAGE_KEY);
  else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

// The interaction that matters most: someone standing at a till. One button opens the
// camera directly through capture="environment". Each shot uploads the moment it is
// taken rather than at Save, so a photo already made it to the server before anything
// else can happen to the page, and Save only groups the ids into one receipt.
export function CaptureSheet({ onCreated }: { onCreated: (receipt: BudgetReceiptWithItems) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<StagedPage[]>([]);
  const [saving, setSaving] = useState(false);

  // Restore an in progress receipt once, on mount: a reload during capture should bring
  // the user back to the pages already uploaded rather than losing them.
  useEffect(() => {
    const ids = readPersistedIds();
    if (ids.length === 0) return;
    setPages(ids.map((documentId) => ({ localId: documentId, status: "done", url: documentsApi.fileUrl(documentId), documentId })));
    setOpen(true);
  }, []);

  function uploadPage(localId: string, file: File) {
    documentsApi.upload(file, () => {}).then(
      (result) => {
        setPages((prev) => {
          const next = prev.map((page): StagedPage =>
            page.localId === localId ? { localId, status: "done", url: page.url, documentId: result.document.id } : page,
          );
          persistDonePages(next);
          return next;
        });
      },
      (error: unknown) => {
        setPages((prev) =>
          prev.map((page): StagedPage =>
            page.localId === localId ? { localId, status: "error", url: page.url, file, error: (error as Error).message } : page,
          ),
        );
      },
    );
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setPages((prev) => {
      const room = MAX_RECEIPT_PAGES - prev.length;
      const incoming = Array.from(fileList).slice(0, room);
      const staged: Extract<StagedPage, { status: "uploading" }>[] = incoming.map((file) => ({
        localId: `local_${nextLocalId++}`,
        status: "uploading",
        url: URL.createObjectURL(file),
        file,
      }));
      for (const page of staged) uploadPage(page.localId, page.file);
      return [...prev, ...staged];
    });
    setOpen(true);
  }

  function retryPage(localId: string) {
    const page = pages.find((p) => p.localId === localId);
    if (!page || page.status !== "error") return;
    setPages((prev) =>
      prev.map((p): StagedPage => (p.localId === localId ? { localId, status: "uploading", url: p.url, file: page.file } : p)),
    );
    uploadPage(localId, page.file);
  }

  function removePage(localId: string) {
    setPages((prev) => {
      const removed = prev.find((page) => page.localId === localId);
      if (removed && removed.url.startsWith("blob:")) URL.revokeObjectURL(removed.url);
      const next = prev.filter((page) => page.localId !== localId);
      persistDonePages(next);
      return next;
    });
  }

  function resetPages() {
    for (const page of pages) if (page.url.startsWith("blob:")) URL.revokeObjectURL(page.url);
    setPages([]);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function handleOpenChange(next: boolean) {
    if (!next && !saving) resetPages();
    setOpen(next);
  }

  const hasPending = pages.some((page) => page.status === "uploading");
  const hasFailed = pages.some((page) => page.status === "error");

  async function handleSave() {
    setSaving(true);
    try {
      const documentIds = pages.filter((page) => page.status === "done").map((page) => page.documentId);
      const { receipt, alreadyExisted } = await budgetApi.createReceipt(documentIds);
      if (alreadyExisted) toast.info("You already saved this receipt.");
      else toast.success("Receipt saved. Reading it now.");
      onCreated(receipt);
      resetPages();
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label="Scan receipt"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <Button onClick={() => inputRef.current?.click()}>Scan receipt</Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scan receipt</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Every photo here is treated as one receipt. Take another shot for a long receipt that spans more than one page.
          </p>
          <ul className="space-y-2">
            {pages.map((page, index) => (
              <li key={page.localId} className="flex flex-col gap-2 rounded-2xl border border-border p-2">
                <div className="flex items-center gap-3">
                  <img src={page.url} alt={`Page ${index + 1}`} className="h-14 w-14 shrink-0 rounded-xl object-cover" />
                  <div className="flex-1">
                    <span className="text-sm font-medium">Page {index + 1}</span>
                    {page.status === "uploading" && <p className="text-xs text-muted-foreground">Uploading...</p>}
                    {page.status === "error" && <p className="text-xs text-destructive">Could not upload this page.</p>}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove page ${index + 1}`}
                    onClick={() => removePage(page.localId)}
                    disabled={saving}
                  >
                    Remove
                  </Button>
                </div>
                {page.status === "error" && (
                  <div className="flex items-center justify-between gap-2 rounded-xl bg-destructive/10 p-2 text-xs text-destructive">
                    <span>{page.error}</span>
                    <Button size="sm" variant="outline" onClick={() => retryPage(page.localId)} disabled={saving}>
                      Retry
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={saving || pages.length >= MAX_RECEIPT_PAGES}
          >
            Add another page
          </Button>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || pages.length === 0 || hasPending || hasFailed}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
