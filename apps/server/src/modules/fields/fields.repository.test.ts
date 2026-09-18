import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { createFieldsRepository } from "./fields.repository.js";

const USER = "user-1";

async function seedDocument(
  db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
  id: string,
  patch: Record<string, unknown> = {},
) {
  const repo = createDocumentsRepository({ db });
  const now = new Date().toISOString();
  await repo.insert({
    id,
    userId: USER,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 10,
    contentHash: id,
    storageDriver: "local",
    storageKey: `${id}.pdf`,
    extractionStatus: "done",
    ruleStatus: "pending",
    embeddingStatus: "pending",
    summaryStatus: "done",
    triageStatus: "reviewed",
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as never);
}

describe("fields repository", () => {
  it("replaces rows for a document rather than duplicating them", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    const repo = createFieldsRepository({ db });

    await repo.replaceForDocument({
      userId: USER,
      documentId: "doc-1",
      fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: 0.8 }],
    });
    await repo.replaceForDocument({
      userId: USER,
      documentId: "doc-1",
      fields: [{ key: "counterparty", value: "Globex", valueNumber: null, valueDate: null, currency: null, confidence: 0.9 }],
    });

    const rows = await repo.listByDocument({ userId: USER, documentId: "doc-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("Globex");
  });

  it("removes rows the new set no longer contains", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    const repo = createFieldsRepository({ db });
    await repo.replaceForDocument({
      userId: USER,
      documentId: "doc-1",
      fields: [
        { key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null },
        { key: "referenceNumber", value: "INV-1", valueNumber: null, valueDate: null, currency: null, confidence: null },
      ],
    });
    await repo.replaceForDocument({
      userId: USER,
      documentId: "doc-1",
      fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }],
    });
    const rows = await repo.listByDocument({ userId: USER, documentId: "doc-1" });
    expect(rows.map((r) => r.key)).toEqual(["counterparty"]);
  });

  it("deletes rows when the document is deleted", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    const repo = createFieldsRepository({ db });
    await repo.replaceForDocument({
      userId: USER,
      documentId: "doc-1",
      fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }],
    });
    await createDocumentsRepository({ db }).remove({ userId: USER, documentId: "doc-1" });
    const rows = await repo.listByDocument({ userId: USER, documentId: "doc-1" });
    expect(rows).toEqual([]);
  });

  it("groups rows by document id", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    await seedDocument(db, "doc-2");
    const repo = createFieldsRepository({ db });
    await repo.replaceForDocument({ userId: USER, documentId: "doc-1", fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }] });
    await repo.replaceForDocument({ userId: USER, documentId: "doc-2", fields: [{ key: "counterparty", value: "Globex", valueNumber: null, valueDate: null, currency: null, confidence: null }] });

    const map = await repo.listByDocumentIds({ userId: USER, documentIds: ["doc-1", "doc-2"] });
    expect(map.get("doc-1")?.[0]?.value).toBe("Acme");
    expect(map.get("doc-2")?.[0]?.value).toBe("Globex");
  });

  it("lists distinct values for a key and leaves trashed documents out", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    await seedDocument(db, "doc-2");
    await seedDocument(db, "doc-3", { deletedAt: new Date().toISOString() });
    const repo = createFieldsRepository({ db });
    for (const [id, value] of [["doc-1", "Acme"], ["doc-2", "Acme"], ["doc-3", "Globex"]] as const) {
      await repo.replaceForDocument({ userId: USER, documentId: id, fields: [{ key: "counterparty", value, valueNumber: null, valueDate: null, currency: null, confidence: null }] });
    }
    const values = await repo.listDistinctValues({ userId: USER, key: "counterparty" });
    expect(values).toEqual(["Acme"]);
  });

  it("reports which documents already have fields", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    await seedDocument(db, "doc-2");
    const repo = createFieldsRepository({ db });
    await repo.replaceForDocument({ userId: USER, documentId: "doc-1", fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }] });
    const withFields = await repo.listDocumentIdsWithFields({ userId: USER });
    expect(withFields.has("doc-1")).toBe(true);
    expect(withFields.has("doc-2")).toBe(false);
  });

  it("does not return another user's rows", async () => {
    const { db } = await createTestDatabase();
    await seedDocument(db, "doc-1");
    const repo = createFieldsRepository({ db });
    await repo.replaceForDocument({ userId: USER, documentId: "doc-1", fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }] });
    expect(await repo.listByDocument({ userId: "someone-else", documentId: "doc-1" })).toEqual([]);
  });
});
