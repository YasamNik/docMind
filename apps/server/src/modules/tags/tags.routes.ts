import type { Context, Hono } from "hono";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import type { Document, DocumentListRow } from "../documents/documents.types.js";
import type { ExtractedField } from "../fields/fields.types.js";
import {
  categoryIdSchema,
  createCategoryBodySchema,
  createTagBodySchema,
  descriptionAssistantBodySchema,
  documentCategoryBodySchema,
  reorderCategoriesBodySchema,
  tagIdSchema,
  updateCategoryBodySchema,
  updateTagBodySchema,
} from "./tags.schemas.js";
import type { TagChip } from "./tags.types.js";
import type { RulesService } from "../rules/rules.usecases.js";
import type { TagsService } from "./tags.usecases.js";

type EnrichedDocument = Document & { categoryPath: string | null; tags: TagChip[]; fields: ExtractedField[] };

// setDocumentCategory returns the full enriched document row, extractedText included.
// Routes must never hand that back to the client, so strip it here before responding.
// No cast: if the enriched shape ever stops matching DocumentListRow, this fails to
// compile instead of silently returning undefined fields.
function omitExtractedText(document: EnrichedDocument): DocumentListRow {
  const { extractedText: _extractedText, ...rest } = document;
  return rest;
}

export function registerTagsRoutes({
  app,
  tagsService,
  rulesService,
  getUserId,
}: {
  app: Hono;
  tagsService: TagsService;
  rulesService?: RulesService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/tags", async (c) => {
    const tags = await tagsService.listTags(getUserId(c));
    return c.json({ tags });
  });

  app.post("/api/tags", async (c) => {
    const body = await parseJsonBody(c, createTagBodySchema);
    const tag = await tagsService.createTag({ userId: getUserId(c), ...body });
    return c.json({ tag }, 201);
  });

  app.patch("/api/tags/:id", async (c) => {
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("id"));
    const patch = await parseJsonBody(c, updateTagBodySchema);
    const tag = await tagsService.updateTag({ userId: getUserId(c), tagId, patch });
    return c.json({ tag });
  });

  app.delete("/api/tags/:id", async (c) => {
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("id"));
    await tagsService.deleteTag({ userId: getUserId(c), tagId });
    return c.body(null, 204);
  });

  app.post("/api/tags/description-assistant", async (c) => {
    const userId = getUserId(c);
    const body = await parseJsonBody(c, descriptionAssistantBodySchema);
    const result = await tagsService.suggestDescription({ userId, ...body });
    return c.json(result);
  });

  app.get("/api/categories", async (c) => {
    const categories = await tagsService.listCategories(getUserId(c));
    return c.json({ categories });
  });

  app.post("/api/categories", async (c) => {
    const body = await parseJsonBody(c, createCategoryBodySchema);
    const category = await tagsService.createCategory({ userId: getUserId(c), ...body });
    return c.json({ category }, 201);
  });

  app.patch("/api/categories/:id", async (c) => {
    const categoryId = parseOrValidationError(categoryIdSchema, c.req.param("id"));
    const patch = await parseJsonBody(c, updateCategoryBodySchema);
    const category = await tagsService.updateCategory({ userId: getUserId(c), categoryId, patch });
    return c.json({ category });
  });

  app.delete("/api/categories/:id", async (c) => {
    const categoryId = parseOrValidationError(categoryIdSchema, c.req.param("id"));
    await tagsService.deleteCategory({ userId: getUserId(c), categoryId });
    return c.body(null, 204);
  });

  app.post("/api/categories/reorder", async (c) => {
    const { a, b } = await parseJsonBody(c, reorderCategoriesBodySchema);
    const [first, second] = await tagsService.reorderCategories({ userId: getUserId(c), a, b });
    return c.json({ categories: [first, second] });
  });

  app.put("/api/documents/:id/category", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { categoryId } = await parseJsonBody(c, documentCategoryBodySchema);
    const userId = getUserId(c);
    const document = await tagsService.setDocumentCategory({ userId, documentId, categoryId });
    if (rulesService && categoryId) {
      rulesService.recordCorrection({ userId, documentId, targetType: "category", targetId: categoryId, signal: "positive" }).catch(() => {});
    }
    return c.json({ document: document ? omitExtractedText(document) : null });
  });

  app.post("/api/documents/:id/tags/:tagId", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("tagId"));
    const userId = getUserId(c);
    const tags = await tagsService.setDocumentTag({ userId, documentId, tagId });
    if (rulesService) {
      rulesService.recordCorrection({ userId, documentId, targetType: "tag", targetId: tagId, signal: "positive" }).catch(() => {});
    }
    return c.json({ tags });
  });

  app.delete("/api/documents/:id/tags/:tagId", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("tagId"));
    const userId = getUserId(c);
    const tags = await tagsService.clearDocumentTag({ userId, documentId, tagId });
    if (rulesService) {
      rulesService.recordCorrection({ userId, documentId, targetType: "tag", targetId: tagId, signal: "negative" }).catch(() => {});
    }
    return c.json({ tags });
  });
}
