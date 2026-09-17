import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "./documents.tables.js";
import type { NewDocument } from "./documents.types.js";

const listColumns = {
  id: documentsTable.id,
  userId: documentsTable.userId,
  name: documentsTable.name,
  mimeType: documentsTable.mimeType,
  sizeBytes: documentsTable.sizeBytes,
  contentHash: documentsTable.contentHash,
  storageDriver: documentsTable.storageDriver,
  storageKey: documentsTable.storageKey,
  extractionStatus: documentsTable.extractionStatus,
  extractionError: documentsTable.extractionError,
  ruleStatus: documentsTable.ruleStatus,
  ruleError: documentsTable.ruleError,
  embeddingStatus: documentsTable.embeddingStatus,
  embeddingError: documentsTable.embeddingError,
  categoryId: documentsTable.categoryId,
  categorySource: documentsTable.categorySource,
  createdAt: documentsTable.createdAt,
  updatedAt: documentsTable.updatedAt,
};

export function createDocumentsRepository({ db }: { db: Database }) {
  return {
    async insert(document: NewDocument, tx: Database = db) {
      await tx.insert(documentsTable).values(document);
    },
    async listByUser(userId: string) {
      return db
        .select(listColumns)
        .from(documentsTable)
        .where(eq(documentsTable.userId, userId))
        .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));
    },
    async findById({ userId, documentId }: { userId: string; documentId: string }) {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      return row ?? null;
    },
    async findByHash({ userId, contentHash }: { userId: string; contentHash: string }) {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.contentHash, contentHash)));
      return row ?? null;
    },
    async update({
      userId,
      documentId,
      patch,
      tx = db,
    }: {
      userId: string;
      documentId: string;
      patch: Partial<NewDocument>;
      tx?: Database;
    }) {
      await tx
        .update(documentsTable)
        .set(patch)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      await db.delete(documentsTable).where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
  };
}
