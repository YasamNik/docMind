import JSZip from "jszip";
import { eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "../documents/documents.tables.js";
import { categoriesTable, documentTagsTable, tagsTable } from "../tags/tags.tables.js";
import { sortEvaluationsTable } from "../rules/rules.tables.js";
import { savedSearchesTable } from "../search/search.tables.js";
import type { StorageService } from "../storage/storage.usecases.js";

export function createExportService({ db, storageService }: { db: Database; storageService: StorageService }) {
  async function exportAll({ userId }: { userId: string }): Promise<Buffer> {
    const documents = await db.select().from(documentsTable).where(eq(documentsTable.userId, userId));
    const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
    const tags = await db.select().from(tagsTable).where(eq(tagsTable.userId, userId));
    const savedSearches = await db.select().from(savedSearchesTable).where(eq(savedSearchesTable.userId, userId));

    const docIds = documents.map((d) => d.id);
    const documentTags = docIds.length > 0
      ? await db.select().from(documentTagsTable)
      : [];
    const evaluations = docIds.length > 0
      ? await db.select().from(sortEvaluationsTable)
      : [];

    const metadata = {
      exportedAt: new Date().toISOString(),
      version: 1,
      documents: documents.map(({ extractedText, ...rest }) => rest),
      categories,
      tags,
      documentTags: documentTags.filter((dt) => docIds.includes(dt.documentId)),
      evaluations: evaluations.filter((e) => docIds.includes(e.documentId)),
      savedSearches,
    };

    const zip = new JSZip();
    zip.file("metadata.json", JSON.stringify(metadata, null, 2));

    for (const doc of documents) {
      if (doc.deletedAt) continue;
      try {
        const driver = await storageService.getDriver(userId, doc.storageDriver);
        const stream = await driver.get({ key: doc.storageKey });
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        zip.file(`files/${doc.id}/${doc.name}`, Buffer.concat(chunks));
      } catch {
        // File might not exist on storage, skip it
      }
    }

    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
  }

  return { exportAll };
}

export type ExportService = ReturnType<typeof createExportService>;
