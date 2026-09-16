import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { documentsApi, type UploadResult } from "@/lib/documents-api";
import { filesFromClipboard } from "@/lib/paste";

type Item = { name: string; percent: number; state: "uploading" | "done" | "duplicate" | "failed"; message?: string };

export function UploadDropzone({ onUploaded }: { onUploaded: (result: UploadResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const uploadAllRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {});

  function update(index: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  async function uploadAll(files: FileList | File[]) {
    const list = Array.from(files);
    const start = items.length;
    setItems((prev) => [...prev, ...list.map((f) => ({ name: f.name, percent: 0, state: "uploading" as const }))]);
    for (const [i, file] of list.entries()) {
      const index = start + i;
      try {
        const result = await documentsApi.upload(file, (p) => update(index, { percent: p }));
        if (result.duplicateOf) {
          update(index, { state: "duplicate", percent: 100, message: `Already in your library as ${result.document.name}` });
          toast.info(`${file.name} is already in your library as ${result.document.name}`);
        } else {
          update(index, { state: "done", percent: 100 });
        }
        onUploaded(result);
      } catch (error) {
        update(index, { state: "failed", message: (error as Error).message });
        toast.error(`${file.name}: ${(error as Error).message}`);
      }
    }
  }

  uploadAllRef.current = uploadAll;

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
      const files = filesFromClipboard(event.clipboardData, new Date());
      if (files.length === 0) return;
      event.preventDefault();
      void uploadAllRef.current(files);
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, []);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void uploadAll(e.dataTransfer.files);
      }}
      className={`rounded-lg border-2 border-dashed p-6 text-center ${over ? "border-primary bg-muted" : "border-muted-foreground/30"}`}
    >
      <p className="text-sm text-muted-foreground mb-3">Drop files here, paste with Ctrl+V, or</p>
      <input
        ref={inputRef}
        id="file-picker"
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files"
        onChange={(e) => {
          if (e.target.files?.length) void uploadAll(e.target.files);
          e.target.value = "";
        }}
      />
      <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
        Choose files
      </Button>
      {items.length > 0 && (
        <ul className="mt-4 text-left text-sm space-y-2">
          {items.map((it, i) => (
            <li key={i}>
              <div className="flex justify-between">
                <span className="truncate">{it.name}</span>
                <span className="text-muted-foreground">{it.state === "uploading" ? `${it.percent}%` : it.state}</span>
              </div>
              <div className="h-1 bg-muted rounded">
                <div className={`h-1 rounded ${it.state === "failed" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${it.percent}%` }} />
              </div>
              {it.message && <p className="text-xs text-muted-foreground">{it.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
