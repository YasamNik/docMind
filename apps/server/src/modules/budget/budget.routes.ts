import type { Context, Hono } from "hono";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import {
  budgetCategoryIdSchema,
  budgetReceiptIdSchema,
  budgetReceiptItemIdSchema,
  createBudgetCategoryBodySchema,
  createReceiptBodySchema,
  monthQuerySchema,
  resolveDuplicateBodySchema,
  updateBudgetCategoryBodySchema,
  updateReceiptBodySchema,
  updateReceiptItemBodySchema,
} from "./budget.schemas.js";
import type { BudgetService } from "./budget.usecases.js";

export function registerBudgetRoutes({
  app,
  budgetService,
  getUserId,
}: {
  app: Hono;
  budgetService: BudgetService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/budget/receipts", async (c) => {
    const userId = getUserId(c);
    const { documentIds } = await parseJsonBody(c, createReceiptBodySchema);
    const { receipt, alreadyExisted } = await budgetService.createReceipt({ userId, documentIds });
    return c.json({ receipt }, alreadyExisted ? 409 : 201);
  });

  app.get("/api/budget/receipts", async (c) => {
    const { month } = parseOrValidationError(monthQuerySchema, c.req.query());
    const receipts = await budgetService.listMonth({ userId: getUserId(c), month });
    return c.json({ receipts });
  });

  app.get("/api/budget/receipts/:id", async (c) => {
    const receiptId = parseOrValidationError(budgetReceiptIdSchema, c.req.param("id"));
    const receipt = await budgetService.getReceipt({ userId: getUserId(c), receiptId });
    return c.json({ receipt });
  });

  app.patch("/api/budget/receipts/:id", async (c) => {
    const receiptId = parseOrValidationError(budgetReceiptIdSchema, c.req.param("id"));
    const patch = await parseJsonBody(c, updateReceiptBodySchema);
    const receipt = await budgetService.updateReceiptFields({ userId: getUserId(c), receiptId, patch });
    return c.json({ receipt });
  });

  app.patch("/api/budget/receipts/:id/items/:itemId", async (c) => {
    const receiptId = parseOrValidationError(budgetReceiptIdSchema, c.req.param("id"));
    const itemId = parseOrValidationError(budgetReceiptItemIdSchema, c.req.param("itemId"));
    const { categoryId } = await parseJsonBody(c, updateReceiptItemBodySchema);
    const receipt = await budgetService.updateReceiptItemCategory({ userId: getUserId(c), receiptId, itemId, categoryId });
    return c.json({ receipt });
  });

  app.post("/api/budget/receipts/:id/resolve", async (c) => {
    const receiptId = parseOrValidationError(budgetReceiptIdSchema, c.req.param("id"));
    const { action } = await parseJsonBody(c, resolveDuplicateBodySchema);
    const result = await budgetService.resolveDuplicate({ userId: getUserId(c), receiptId, action });
    return c.json(result);
  });

  app.get("/api/budget/categories", async (c) => {
    const categories = await budgetService.listCategories({ userId: getUserId(c) });
    return c.json({ categories });
  });

  app.post("/api/budget/categories", async (c) => {
    const body = await parseJsonBody(c, createBudgetCategoryBodySchema);
    const category = await budgetService.createCategory({ userId: getUserId(c), ...body });
    return c.json({ category }, 201);
  });

  app.patch("/api/budget/categories/:id", async (c) => {
    const categoryId = parseOrValidationError(budgetCategoryIdSchema, c.req.param("id"));
    const patch = await parseJsonBody(c, updateBudgetCategoryBodySchema);
    const category = await budgetService.updateCategory({ userId: getUserId(c), categoryId, patch });
    return c.json({ category });
  });

  app.delete("/api/budget/categories/:id", async (c) => {
    const categoryId = parseOrValidationError(budgetCategoryIdSchema, c.req.param("id"));
    await budgetService.deleteCategory({ userId: getUserId(c), categoryId });
    return c.body(null, 204);
  });
}
