import type { budgetCategoriesTable, budgetReceiptItemsTable, budgetReceiptsTable } from "./budget.tables.js";

export type BudgetCategory = typeof budgetCategoriesTable.$inferSelect;
export type NewBudgetCategory = typeof budgetCategoriesTable.$inferInsert;

export type BudgetReceipt = typeof budgetReceiptsTable.$inferSelect;
export type NewBudgetReceipt = typeof budgetReceiptsTable.$inferInsert;

export type BudgetReceiptItem = typeof budgetReceiptItemsTable.$inferSelect;
export type NewBudgetReceiptItem = typeof budgetReceiptItemsTable.$inferInsert;

export type BudgetReceiptStatus = "pending" | "ready" | "needs_review" | "failed";
export type BudgetCategorySource = "auto" | "manual";

export type BudgetReceiptWithItems = BudgetReceipt & { items: BudgetReceiptItem[] };
