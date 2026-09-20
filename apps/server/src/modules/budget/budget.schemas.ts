import * as v from "valibot";
import { documentIdSchema } from "../documents/documents.schemas.js";
import { MAX_RECEIPT_PAGES } from "./budget.models.js";

export const budgetReceiptIdSchema = v.pipe(v.string(), v.regex(/^brcpt_[0-9a-f]{16}$/));
export const budgetReceiptItemIdSchema = v.pipe(v.string(), v.regex(/^britem_[0-9a-f]{16}$/));
export const budgetCategoryIdSchema = v.pipe(v.string(), v.regex(/^bcat_[0-9a-f]{16}$/));

export const createReceiptBodySchema = v.object({
  documentIds: v.pipe(v.array(documentIdSchema), v.minLength(1), v.maxLength(MAX_RECEIPT_PAGES)),
});

export const receiptJobPayloadSchema = v.object({
  receiptId: budgetReceiptIdSchema,
  userId: v.string(),
  documentIds: v.pipe(v.array(v.string()), v.minLength(1)),
});

export const monthQuerySchema = v.object({
  month: v.pipe(v.string(), v.regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")),
});

const nullableAmount = v.nullable(v.number());

export const updateReceiptBodySchema = v.object({
  merchant: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(200)))),
  purchasedAt: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)))),
  currency: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[A-Za-z]{3}$/), v.transform((s) => s.toUpperCase())))),
  total: v.optional(nullableAmount),
  taxAmount: v.optional(nullableAmount),
  categoryId: v.optional(v.nullable(budgetCategoryIdSchema)),
});

export const updateReceiptItemBodySchema = v.object({
  categoryId: v.nullable(budgetCategoryIdSchema),
});

export const resolveDuplicateBodySchema = v.object({
  action: v.picklist(["keep", "delete"]),
});

const budgetCategoryNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60));
const budgetCategoryDescriptionSchema = v.pipe(v.string(), v.maxLength(2000));
const budgetCategoryColorSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value like #4f46e5"));

export const createBudgetCategoryBodySchema = v.object({
  name: budgetCategoryNameSchema,
  description: v.optional(budgetCategoryDescriptionSchema, ""),
  color: v.optional(v.nullable(budgetCategoryColorSchema), null),
  autoApply: v.optional(v.boolean(), true),
});

export const updateBudgetCategoryBodySchema = v.object({
  name: v.optional(budgetCategoryNameSchema),
  description: v.optional(budgetCategoryDescriptionSchema),
  color: v.optional(v.nullable(budgetCategoryColorSchema)),
  autoApply: v.optional(v.boolean()),
});

// The reply schema stays loose on purpose: generateStructuredFromImages parses the whole
// reply in one pass and throws on any nested failure, so asserting the shape of a header
// value or of the items array would let one bad line take down a correct merchant and
// total. Every check happens after parsing, in budget.models.ts, dropping only the
// offending row. Same discipline as rules.schemas.ts and summary.schemas.ts.
export const budgetReceiptReplySchema = v.object({
  merchant: v.optional(v.nullable(v.string())),
  purchasedAt: v.optional(v.nullable(v.string())),
  currency: v.optional(v.nullable(v.string())),
  total: v.optional(v.unknown()),
  taxAmount: v.optional(v.unknown()),
  category: v.optional(v.nullable(v.string())),
  categoryConfidence: v.optional(v.unknown()),
  warning: v.optional(v.nullable(v.string())),
  items: v.optional(v.unknown()),
});

export type RawBudgetReceiptReply = v.InferOutput<typeof budgetReceiptReplySchema>;
