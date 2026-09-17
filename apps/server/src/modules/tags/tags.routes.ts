import type { Context, Hono } from "hono";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import type { DocumentListRow } from "../documents/documents.types.js";
import {
  categoryIdSchema,
  createCategoryBodySchema,
  createTagBodySchema,
  documentCategoryBodySchema,
  tagIdSchema,
  updateCategoryBodySchema,
  updateTagBodySchema,
} from "./tags.schemas.js";
import type { TagsService } from "./tags.usecases.js";

// setDocumentCategory returns the full document row, extractedText included. Routes
// must never hand that back to the client, so strip it here before responding.
function omitExtractedText(document: { extractedText: string | null } & Record<string, unknown>): DocumentListRow {
  const { extractedText: _extractedText, ...rest } = document;
  return rest as DocumentListRow;
}

export function registerTagsRoutes({
  app,
  tagsService,
  getUserId,
}: {
  app: Hono;
  tagsService: TagsService;
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

  app.put("/api/documents/:id/category", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { categoryId } = await parseJsonBody(c, documentCategoryBodySchema);
    const document = await tagsService.setDocumentCategory({ userId: getUserId(c), documentId, categoryId });
    return c.json({ document: document ? omitExtractedText(document) : null });
  });

  app.post("/api/documents/:id/tags/:tagId", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("tagId"));
    const tags = await tagsService.setDocumentTag({ userId: getUserId(c), documentId, tagId });
    return c.json({ tags });
  });

  app.delete("/api/documents/:id/tags/:tagId", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("tagId"));
    const tags = await tagsService.clearDocumentTag({ userId: getUserId(c), documentId, tagId });
    return c.json({ tags });
  });
}
