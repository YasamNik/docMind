import { api, ApiError } from "./api";

// The server's own limit on photos per receipt (budget.models.ts's MAX_RECEIPT_PAGES).
// Duplicated here rather than fetched, the same way other client-side limits mirror a
// server constant: the capture sheet needs it before any request goes out.
export const MAX_RECEIPT_PAGES = 10;

export type BudgetReceiptStatus = "pending" | "ready" | "needs_review" | "failed";

// A line's category can also be unset (neither auto nor manual yet), which the auto/manual
// union alone does not cover.
export type BudgetCategorySource = "auto" | "manual" | null;

export type BudgetReceiptItem = {
  id: string;
  receiptId: string;
  lineNumber: number;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  categoryId: string | null;
  categorySource: BudgetCategorySource;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
};

export type BudgetReceipt = {
  id: string;
  documentId: string;
  merchant: string | null;
  categoryId: string | null;
  purchasedAt: string | null;
  currency: string | null;
  total: number | null;
  taxAmount: number | null;
  status: BudgetReceiptStatus;
  note: string | null;
  duplicateOfReceiptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BudgetReceiptWithItems = BudgetReceipt & { items: BudgetReceiptItem[] };

// budget_categories.auto_apply is a plain 0/1 integer column, and unlike tags, document
// categories, and document types, the budget usecases return every category row as-is
// with no boolean conversion. Typed as a number here to match what the API actually sends.
export type BudgetCategory = {
  id: string;
  name: string;
  description: string;
  color: string | null;
  autoApply: number;
  createdAt: string;
  updatedAt: string;
};

export type BudgetCategoryInput = {
  name: string;
  description?: string;
  color?: string | null;
  autoApply?: boolean;
};

export type ReceiptFieldsPatch = {
  merchant?: string | null;
  purchasedAt?: string | null;
  currency?: string | null;
  total?: number | null;
  taxAmount?: number | null;
  categoryId?: string | null;
};

async function errorFromResponse(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = res.statusText || "Request failed";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // body was not JSON
  }
  return new ApiError({ code, message, status: res.status });
}

export const budgetApi = {
  // A 409 here is not an error envelope: the route answers it with the same { receipt }
  // body as a 201, carrying the receipt that already exists for this document (see
  // budget.routes.ts). api.json would read any non-2xx as a failure and discard that
  // receipt, so this reads both statuses the same way instead.
  async createReceipt(documentIds: string[]): Promise<{ receipt: BudgetReceiptWithItems; alreadyExisted: boolean }> {
    const res = await fetch("/api/budget/receipts", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentIds }),
    });
    if (res.status === 201 || res.status === 409) {
      const body = (await res.json()) as { receipt: BudgetReceiptWithItems };
      return { receipt: body.receipt, alreadyExisted: res.status === 409 };
    }
    throw await errorFromResponse(res);
  },
  // nearestMonthWithReceipts is null unless this month came back with no receipts of its
  // own and the user has at least one receipt in some other month: the Budget page uses
  // it to explain an empty month rather than showing a blank list with no reason given.
  async listMonth(month: string) {
    return api.get<{ receipts: BudgetReceiptWithItems[]; nearestMonthWithReceipts: string | null }>(`/api/budget/receipts?month=${month}`);
  },
  async getReceipt(id: string) {
    return (await api.get<{ receipt: BudgetReceiptWithItems }>(`/api/budget/receipts/${id}`)).receipt;
  },
  async updateReceipt(id: string, patch: ReceiptFieldsPatch) {
    return (await api.json<{ receipt: BudgetReceiptWithItems }>("PATCH", `/api/budget/receipts/${id}`, patch)).receipt;
  },
  async updateItemCategory(receiptId: string, itemId: string, categoryId: string | null) {
    return (await api.json<{ receipt: BudgetReceiptWithItems }>("PATCH", `/api/budget/receipts/${receiptId}/items/${itemId}`, { categoryId })).receipt;
  },
  resolveDuplicate(receiptId: string, action: "keep" | "delete") {
    return api.json<{ deleted: true } | { receipt: BudgetReceiptWithItems }>("POST", `/api/budget/receipts/${receiptId}/resolve`, { action });
  },
  async listCategories() {
    return (await api.get<{ categories: BudgetCategory[] }>("/api/budget/categories")).categories;
  },
  async createCategory(input: BudgetCategoryInput) {
    return (await api.json<{ category: BudgetCategory }>("POST", "/api/budget/categories", input)).category;
  },
  async updateCategory(id: string, patch: Partial<BudgetCategoryInput>) {
    return (await api.json<{ category: BudgetCategory }>("PATCH", `/api/budget/categories/${id}`, patch)).category;
  },
  removeCategory(id: string) {
    return api.del(`/api/budget/categories/${id}`);
  },
};
