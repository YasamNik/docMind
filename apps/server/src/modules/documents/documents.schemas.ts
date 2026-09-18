import * as v from "valibot";
import { categoryIdSchema, documentTypeIdSchema, tagIdSchema } from "../tags/tags.schemas.js";

export const uploadQuerySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const renameBodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const documentIdSchema = v.pipe(v.string(), v.regex(/^doc_[0-9a-f]{16}$/));

export const documentViewSchema = v.picklist(["inbox", "needs_review", "all", "trash"]);

export const listDocumentsQuerySchema = v.object({
  categoryId: v.optional(categoryIdSchema),
  documentTypeId: v.optional(documentTypeIdSchema),
  tagId: v.optional(tagIdSchema),
  view: v.optional(documentViewSchema, "all"),
});

export const triageActionSchema = v.object({
  action: v.literal("accept"),
  acceptTitle: v.optional(v.boolean(), false),
});

export const triageBatchSchema = v.object({
  documentIds: v.pipe(v.array(documentIdSchema), v.minLength(1), v.maxLength(100)),
  action: v.literal("accept"),
});

const documentIdsSchema = v.pipe(v.array(documentIdSchema), v.minLength(1), v.maxLength(100));

export const bulkDeleteSchema = v.object({ documentIds: documentIdsSchema });

export const bulkTagSchema = v.object({
  documentIds: documentIdsSchema,
  tagId: tagIdSchema,
  action: v.picklist(["add", "remove"]),
});

export const bulkCategorySchema = v.object({
  documentIds: documentIdsSchema,
  categoryId: v.nullable(categoryIdSchema),
});

export const bulkSortSchema = v.object({ documentIds: documentIdsSchema });
