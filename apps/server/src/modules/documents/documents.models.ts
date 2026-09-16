import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Transform } from "node:stream";

export function newDocumentId() {
  return `doc_${randomBytes(8).toString("hex")}`;
}

export function sanitizeFilename(name: string) {
  const base = basename(name.trim().replace(/\\/g, "/")).replace(/\p{Cc}/gu, "").trim();
  return base.length > 0 ? base.slice(0, 255) : "untitled";
}

export function hashingCounter() {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    transform,
    result() {
      return { sha256: hash.digest("hex"), sizeBytes };
    },
  };
}

export function nowIso() {
  return new Date().toISOString();
}
