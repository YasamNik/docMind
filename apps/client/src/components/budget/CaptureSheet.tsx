import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { budgetApi, MAX_RECEIPT_PAGES, type BudgetReceiptWithItems } from "@/lib/budget-api";
import { documentsApi } from "@/lib/documents-api";

type StagedPage = { file: File; url: string };

// The interaction that matters most: someone standing at a till. One button opens the
// camera directly through capture="environment", every shot joins a visible list so a
// long receipt's pages are grouped explicitly by the person taking them, and Save is the
// only network round trip, run in the order the photos were taken.
export function CaptureSheet({ onCreated }: { onCreated: (receipt: BudgetReceiptWithItems) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<StagedPage[]>([]);
  const [saving, setSaving] = useState(false);

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const room = MAX_RECEIPT_PAGES - pages.length;
    const incoming = Array.from(fileList).slice(0, room);
    setPages((prev) => [...prev, ...incoming.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    setOpen(true);
  }

  function removePage(index: number) {
    setPages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== index);
    });
  }

  function resetPages() {
    for (const page of pages) URL.revokeObjectURL(page.url);
    setPages([]);
  }

  function handleOpenChange(next: boolean) {
    if (!next && !saving) resetPages();
    setOpen(next);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const documentIds: string[] = [];
      for (const page of pages) {
        const result = await documentsApi.upload(page.file, () => {});
        documentIds.push(result.document.id);
      }
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
              <li key={page.url} className="flex items-center gap-3 rounded-2xl border border-border p-2">
                <img src={page.url} alt={`Page ${index + 1}`} className="h-14 w-14 shrink-0 rounded-xl object-cover" />
                <span className="flex-1 text-sm font-medium">Page {index + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove page ${index + 1}`}
                  onClick={() => removePage(index)}
                  disabled={saving}
                >
                  Remove
                </Button>
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
            <Button onClick={handleSave} disabled={saving || pages.length === 0}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
