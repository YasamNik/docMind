import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "./documents.tables.js";
import type { NewDocument } from "./documents.types.js";

export function createDocumentsRepository({ db }: { db: Database }) {
  return {
    async insert(document: NewDocument) {
      await db.insert(documentsTable).values(document);
    },
    async listByUser(userId: string) {
      return db
        .select()
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
    async update({ userId, documentId, patch }: { userId: string; documentId: string; patch: Partial<NewDocument> }) {
      await db
        .update(documentsTable)
        .set(patch)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      await db.delete(documentsTable).where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
  };
}
