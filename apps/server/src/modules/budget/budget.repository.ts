import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { asTxDb, type Database } from "../database/database.js";
import { budgetCategoriesTable, budgetReceiptItemsTable, budgetReceiptsTable } from "./budget.tables.js";
import type {
  BudgetCategory,
  BudgetReceipt,
  BudgetReceiptItem,
  BudgetReceiptWithItems,
  NewBudgetCategory,
  NewBudgetReceipt,
  NewBudgetReceiptItem,
} from "./budget.types.js";

function groupItemsByReceipt(items: BudgetReceiptItem[]): Map<string, BudgetReceiptItem[]> {
  const map = new Map<string, BudgetReceiptItem[]>();
  for (const item of items) {
    const list = map.get(item.receiptId) ?? [];
    list.push(item);
    map.set(item.receiptId, list);
  }
  return map;
}

export function createBudgetRepository({ db }: { db: Database }) {
  return {
    // Both rows must land together: a receipt with no items yet is a fine intermediate
    // state for a job that has not run, but a receipt row committed without the items a
    // caller already has in hand would leave the two permanently out of step.
    async insertReceiptWithItems({ receipt, items }: { receipt: NewBudgetReceipt; items: NewBudgetReceiptItem[] }): Promise<void> {
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await txDb.insert(budgetReceiptsTable).values(receipt);
        if (items.length > 0) await txDb.insert(budgetReceiptItemsTable).values(items);
      });
    },

    async findReceiptById({ userId, receiptId }: { userId: string; receiptId: string }): Promise<BudgetReceipt | null> {
      const [row] = await db
        .select()
        .from(budgetReceiptsTable)
        .where(and(eq(budgetReceiptsTable.userId, userId), eq(budgetReceiptsTable.id, receiptId)));
      return row ?? null;
    },

    // The unique index on (user_id, document_id) means a second receipt built on the
    // same page 1 is a conflict, not a new row. Checked before insert so the usual path
    // never has to fall back to catching the constraint error.
    async findReceiptByDocumentId({ userId, documentId }: { userId: string; documentId: string }): Promise<BudgetReceipt | null> {
      const [row] = await db
        .select()
        .from(budgetReceiptsTable)
        .where(and(eq(budgetReceiptsTable.userId, userId), eq(budgetReceiptsTable.documentId, documentId)));
      return row ?? null;
    },

    async updateReceipt({
      userId,
      receiptId,
      patch,
      tx = db,
    }: {
      userId: string;
      receiptId: string;
      patch: Partial<NewBudgetReceipt>;
      tx?: Database;
    }) {
      await tx
        .update(budgetReceiptsTable)
        .set(patch)
        .where(and(eq(budgetReceiptsTable.userId, userId), eq(budgetReceiptsTable.id, receiptId)));
    },

    // The read job's finalize step: the receipt row was already inserted pending, with
    // no items, when the job was enqueued. This fills in what the model read and writes
    // the item rows in the one transaction, so a receipt is never seen with a header but
    // no items or the other way around.
    async updateReceiptWithItems({
      userId,
      receiptId,
      patch,
      items,
    }: {
      userId: string;
      receiptId: string;
      patch: Partial<NewBudgetReceipt>;
      items: NewBudgetReceiptItem[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await txDb
          .update(budgetReceiptsTable)
          .set(patch)
          .where(and(eq(budgetReceiptsTable.userId, userId), eq(budgetReceiptsTable.id, receiptId)));
        if (items.length > 0) await txDb.insert(budgetReceiptItemsTable).values(items);
      });
    },

    async deleteReceipt({ userId, receiptId }: { userId: string; receiptId: string }): Promise<void> {
      await db.delete(budgetReceiptsTable).where(and(eq(budgetReceiptsTable.userId, userId), eq(budgetReceiptsTable.id, receiptId)));
    },

    async findReceiptItemById({ userId, itemId }: { userId: string; itemId: string }): Promise<BudgetReceiptItem | null> {
      const [row] = await db
        .select()
        .from(budgetReceiptItemsTable)
        .where(and(eq(budgetReceiptItemsTable.userId, userId), eq(budgetReceiptItemsTable.id, itemId)));
      return row ?? null;
    },

    async updateReceiptItem({
      userId,
      itemId,
      patch,
    }: {
      userId: string;
      itemId: string;
      patch: Partial<NewBudgetReceiptItem>;
    }): Promise<void> {
      await db
        .update(budgetReceiptItemsTable)
        .set(patch)
        .where(and(eq(budgetReceiptItemsTable.userId, userId), eq(budgetReceiptItemsTable.id, itemId)));
    },

    async findReceiptWithItems({ userId, receiptId }: { userId: string; receiptId: string }): Promise<BudgetReceiptWithItems | null> {
      const [receipt] = await db
        .select()
        .from(budgetReceiptsTable)
        .where(and(eq(budgetReceiptsTable.userId, userId), eq(budgetReceiptsTable.id, receiptId)));
      if (!receipt) return null;
      const items = await db
        .select()
        .from(budgetReceiptItemsTable)
        .where(eq(budgetReceiptItemsTable.receiptId, receiptId))
        .orderBy(asc(budgetReceiptItemsTable.lineNumber));
      return { ...receipt, items };
    },

    // month is "YYYY-MM". purchased_at is indexed and stored as "YYYY-MM-DD", so a month
    // is a plain string prefix, no separate month column needed.
    async listMonthReceiptsWithItems({ userId, month }: { userId: string; month: string }): Promise<BudgetReceiptWithItems[]> {
      const receipts = await db
        .select()
        .from(budgetReceiptsTable)
        .where(and(eq(budgetReceiptsTable.userId, userId), like(budgetReceiptsTable.purchasedAt, `${month}%`)))
        .orderBy(desc(budgetReceiptsTable.purchasedAt), desc(budgetReceiptsTable.createdAt));
      if (receipts.length === 0) return [];
      const items = await db
        .select()
        .from(budgetReceiptItemsTable)
        .where(inArray(budgetReceiptItemsTable.receiptId, receipts.map((r) => r.id)))
        .orderBy(asc(budgetReceiptItemsTable.lineNumber));
      const itemsByReceipt = groupItemsByReceipt(items);
      return receipts.map((r) => ({ ...r, items: itemsByReceipt.get(r.id) ?? [] }));
    },

    // The four value duplicate rule from the design spec: merchant compared trimmed and
    // case insensitively, purchasedAt, total, and currency all equal. excludeReceiptId
    // lets a re-read check against every other receipt without matching itself.
    async findDuplicate({
      userId,
      merchant,
      purchasedAt,
      total,
      currency,
      excludeReceiptId,
    }: {
      userId: string;
      merchant: string;
      purchasedAt: string;
      total: number;
      currency: string;
      excludeReceiptId?: string;
    }): Promise<BudgetReceipt | null> {
      const rows = await db
        .select()
        .from(budgetReceiptsTable)
        .where(
          and(
            eq(budgetReceiptsTable.userId, userId),
            sql`lower(trim(${budgetReceiptsTable.merchant})) = lower(trim(${merchant}))`,
            eq(budgetReceiptsTable.purchasedAt, purchasedAt),
            eq(budgetReceiptsTable.total, total),
            eq(budgetReceiptsTable.currency, currency),
          ),
        );
      const match = excludeReceiptId ? rows.find((r) => r.id !== excludeReceiptId) : rows[0];
      return match ?? null;
    },

    async insertCategory(category: NewBudgetCategory) {
      await db.insert(budgetCategoriesTable).values(category);
    },

    async findCategoryById({ userId, categoryId }: { userId: string; categoryId: string }): Promise<BudgetCategory | null> {
      const [row] = await db
        .select()
        .from(budgetCategoriesTable)
        .where(and(eq(budgetCategoriesTable.userId, userId), eq(budgetCategoriesTable.id, categoryId)));
      return row ?? null;
    },

    async listCategoriesRaw(userId: string): Promise<BudgetCategory[]> {
      return db.select().from(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, userId));
    },

    async updateCategory({
      userId,
      categoryId,
      patch,
      tx = db,
    }: {
      userId: string;
      categoryId: string;
      patch: Partial<NewBudgetCategory>;
      tx?: Database;
    }) {
      await tx
        .update(budgetCategoriesTable)
        .set(patch)
        .where(and(eq(budgetCategoriesTable.userId, userId), eq(budgetCategoriesTable.id, categoryId)));
    },

    async deleteCategory({ userId, categoryId, tx = db }: { userId: string; categoryId: string; tx?: Database }) {
      await tx.delete(budgetCategoriesTable).where(and(eq(budgetCategoriesTable.userId, userId), eq(budgetCategoriesTable.id, categoryId)));
    },
  };
}

export type BudgetRepository = ReturnType<typeof createBudgetRepository>;
