// Minimal structural type covering what filesFromClipboard reads from a clipboard
// paste event, loose enough to satisfy both the real DataTransfer and test doubles.
export type ClipboardDataLike = {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
  files?: ArrayLike<File>;
  getData(type: string): string;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function pastedTimestamp(now: Date): string {
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${year}-${month}-${day} ${hours}-${minutes}-${seconds}`;
}

function extensionFromMimeType(type: string): string {
  const subtype = type.split("/")[1];
  if (!subtype) return "bin";
  if (subtype === "jpeg") return "jpg";
  return subtype;
}

export function pastedImageName(type: string, now: Date): string {
  return `Pasted image ${pastedTimestamp(now)}.${extensionFromMimeType(type)}`;
}

function isGenericName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "") return true;
  if (trimmed.toLowerCase() === "blob") return true;
  if (trimmed.toLowerCase() === "image.png") return true;
  return false;
}

export function filesFromClipboard(data: ClipboardDataLike | null, now: Date): File[] {
  if (!data) return [];

  const items = data.items ? Array.from(data.items) : [];
  const fileItems = items.filter((item) => item.kind === "file");

  if (fileItems.length > 0) {
    const files: File[] = [];
    for (const item of fileItems) {
      const file = item.getAsFile();
      if (!file) continue;
      if (isGenericName(file.name)) {
        const renamed = new File([file], pastedImageName(file.type, now), { type: file.type });
        files.push(renamed);
      } else {
        files.push(file);
      }
    }
    return files;
  }

  const text = data.getData("text/plain").trimEnd();
  if (text.trim() === "") return [];

  return [new File([text], `Pasted text ${pastedTimestamp(now)}.txt`, { type: "text/plain" })];
}
