import { describe, expect, it } from "vitest";
import { filesFromClipboard, pastedImageName, pastedTimestamp } from "./paste";

const now = new Date(2026, 8, 16, 9, 5, 3); // 2026-09-16 09:05:03 local time

describe("pastedTimestamp", () => {
  it("formats local time zero padded with hyphens and no colons", () => {
    expect(pastedTimestamp(now)).toBe("2026-09-16 09-05-03");
  });

  it("pads single digit months, days, hours, minutes, seconds", () => {
    const early = new Date(2026, 0, 2, 3, 4, 5);
    expect(pastedTimestamp(early)).toBe("2026-01-02 03-04-05");
  });
});

describe("pastedImageName", () => {
  it("names png images", () => {
    expect(pastedImageName("image/png", now)).toBe("Pasted image 2026-09-16 09-05-03.png");
  });

  it("maps jpeg to jpg", () => {
    expect(pastedImageName("image/jpeg", now)).toBe("Pasted image 2026-09-16 09-05-03.jpg");
  });

  it("keeps webp as is", () => {
    expect(pastedImageName("image/webp", now)).toBe("Pasted image 2026-09-16 09-05-03.webp");
  });

  it("falls back to bin for a type with no subtype", () => {
    expect(pastedImageName("bogus", now)).toBe("Pasted image 2026-09-16 09-05-03.bin");
  });

  it("uses the subtype as is for unknown image types", () => {
    expect(pastedImageName("image/heic", now)).toBe("Pasted image 2026-09-16 09-05-03.heic");
  });
});

function makeClipboardData(opts: {
  items?: Array<{ kind: string; type: string; file: File | null }>;
  text?: string;
}) {
  const items = opts.items ?? [];
  return {
    items: items.map((it) => ({
      kind: it.kind,
      type: it.type,
      getAsFile: () => it.file,
    })),
    files: items.filter((it) => it.file).map((it) => it.file) as File[],
    getData: (type: string) => (type === "text/plain" ? (opts.text ?? "") : ""),
  };
}

describe("filesFromClipboard", () => {
  it("returns [] for null data", () => {
    expect(filesFromClipboard(null, now)).toEqual([]);
  });

  it("returns [] when there is nothing usable", () => {
    const data = makeClipboardData({ text: "   " });
    expect(filesFromClipboard(data, now)).toEqual([]);
  });

  it("keeps a real file name", () => {
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });
    const data = makeClipboardData({ items: [{ kind: "file", type: "application/pdf", file }] });
    const result = filesFromClipboard(data, now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("report.pdf");
  });

  it("renames a generic image blob", () => {
    const file = new File(["x"], "image.png", { type: "image/png" });
    const data = makeClipboardData({ items: [{ kind: "file", type: "image/png", file }] });
    const result = filesFromClipboard(data, now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Pasted image 2026-09-16 09-05-03.png");
  });

  it("renames an unnamed image blob with empty name", () => {
    const file = new File(["x"], "", { type: "image/png" });
    const data = makeClipboardData({ items: [{ kind: "file", type: "image/png", file }] });
    const result = filesFromClipboard(data, now);
    expect(result[0].name).toBe("Pasted image 2026-09-16 09-05-03.png");
  });

  it("renames a blob named blob", () => {
    const file = new File(["x"], "blob", { type: "image/jpeg" });
    const data = makeClipboardData({ items: [{ kind: "file", type: "image/jpeg", file }] });
    const result = filesFromClipboard(data, now);
    expect(result[0].name).toBe("Pasted image 2026-09-16 09-05-03.jpg");
  });

  it("builds a text/plain File from pasted text when no file item exists", async () => {
    const data = makeClipboardData({ text: "hello world  \n\n" });
    const result = filesFromClipboard(data, now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Pasted text 2026-09-16 09-05-03.txt");
    expect(result[0].type).toBe("text/plain");
    await expect(result[0].text()).resolves.toBe("hello world");
  });

  it("returns [] for whitespace only text", () => {
    const data = makeClipboardData({ text: "   \n  " });
    expect(filesFromClipboard(data, now)).toEqual([]);
  });

  it("prefers files over text when both are present", () => {
    const file = new File(["x"], "report.pdf", { type: "application/pdf" });
    const data = makeClipboardData({ items: [{ kind: "file", type: "application/pdf", file }], text: "hello" });
    const result = filesFromClipboard(data, now);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("report.pdf");
  });
});
