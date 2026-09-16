import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createDocumentsService } from "./documents.usecases.js";

let root: string;
let documents: ReturnType<typeof createDocumentsService>;
const userId = "user-1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-docs-"));
  const { db } = await createTestDatabase();
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(storageSettingDefinitions),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  documents = createDocumentsService({ db, storageService: createStorageService({ settingsService }) });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

describe("documents service", () => {
  it("uploads, stores, and reads back a file", async () => {
    const { document, duplicateOf } = await documents.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello"]) });
    expect(duplicateOf).toBeUndefined();
    expect(document).toMatchObject({ name: "notes.txt", mimeType: "text/plain", sizeBytes: 5, storageDriver: "local", extractionStatus: "pending" });
    expect(document.storageKey).toBe(`${userId}/${document.id}/notes.txt`);
    const { stream } = await documents.openFile({ userId, documentId: document.id });
    expect(await readAll(stream)).toBe("hello");
  });

  it("detects duplicates by content hash and keeps one file", async () => {
    const first = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    const second = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    expect(second.duplicateOf).toBe(first.document.id);
    expect(second.document.id).toBe(first.document.id);
    expect((await documents.list({ userId })).length).toBe(1);
  });

  it("lists newest first, renames, and removes with the file", async () => {
    const a = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const b = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    expect((await documents.list({ userId })).map((d) => d.id)).toEqual([b.document.id, a.document.id]);
    await documents.rename({ userId, documentId: a.document.id, name: "renamed.txt" });
    expect((await documents.get({ userId, documentId: a.document.id })).name).toBe("renamed.txt");
    await documents.remove({ userId, documentId: a.document.id });
    await expectAppError(() => documents.get({ userId, documentId: a.document.id }), "documents.not_found");
  });

  it("scopes everything by user", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await expectAppError(() => documents.get({ userId: "someone-else", documentId: document.id }), "documents.not_found");
    expect(await documents.list({ userId: "someone-else" })).toEqual([]);
  });
});
