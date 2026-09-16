import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { hashingCounter, newDocumentId, sanitizeFilename } from "./documents.models.js";

describe("documents models", () => {
  it("hashes and counts bytes while passing data through", async () => {
    const counter = hashingCounter();
    const out: Buffer[] = [];
    await pipeline(Readable.from([Buffer.from("hello "), Buffer.from("world")]), counter.transform, async function* (source) {
      for await (const chunk of source) out.push(chunk as Buffer);
    });
    expect(Buffer.concat(out).toString()).toBe("hello world");
    expect(counter.result()).toEqual({
      sha256: createHash("sha256").update("hello world").digest("hex"),
      sizeBytes: 11,
    });
  });

  it("sanitizes file names", () => {
    expect(sanitizeFilename("  My Report (final).PDF ")).toBe("My Report (final).PDF");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("")).toBe("untitled");
  });

  it("makes prefixed ids", () => {
    expect(newDocumentId()).toMatch(/^doc_[0-9a-f]{16}$/);
  });
});
