import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";
import { createError } from "../../shared/errors/errors.js";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { bulkCategorySchema, bulkDeleteSchema, bulkSortSchema, bulkTagSchema, documentIdSchema, listDocumentsQuerySchema, renameBodySchema, triageActionSchema, triageBatchSchema, uploadQuerySchema } from "./documents.schemas.js";
import type { DocumentsService } from "./documents.usecases.js";
import type { TagsService } from "../tags/tags.usecases.js";
import type { RulesService } from "../rules/rules.usecases.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function registerDocumentsRoutes({
  app,
  documentsService,
  tagsService,
  rulesService,
  getUserId,
}: {
  app: Hono;
  documentsService: DocumentsService;
  tagsService?: TagsService;
  rulesService?: RulesService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/documents", async (c) => {
    const userId = getUserId(c);
    const { name } = parseOrValidationError(uploadQuerySchema, c.req.query());
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES) {
      throw createError({ code: "documents.too_large", message: `Uploads are limited to ${MAX_UPLOAD_BYTES} bytes`, status: 413 });
    }
    if (!c.req.raw.body) throw createError({ code: "validation", message: "Request body is required", status: 400 });
    const body = Readable.fromWeb(c.req.raw.body as unknown as NodeReadableStream);
    const mimeType = c.req.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const result = await documentsService.upload({ userId, name, mimeType, body, maxUploadBytes: MAX_UPLOAD_BYTES });
    return c.json(result, result.duplicateOf ? 200 : 201);
  });

  app.get("/api/documents", async (c) => {
    const { categoryId, documentTypeId, tagId, view } = parseOrValidationError(listDocumentsQuerySchema, c.req.query());
    const documents = await documentsService.list({ userId: getUserId(c), categoryId, documentTypeId, tagId, view });
    return c.json({ documents });
  });

  app.get("/api/documents/counts", async (c) => {
    const counts = await documentsService.counts({ userId: getUserId(c) });
    return c.json(counts);
  });

  app.get("/api/documents/:id", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const document = await documentsService.get({ userId: getUserId(c), documentId });
    return c.json({ document });
  });

  app.get("/api/documents/:id/file", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { document, stream: file } = await documentsService.openFile({ userId: getUserId(c), documentId });
    const disposition = c.req.query("download") ? "attachment" : "inline";
    c.header("Content-Type", document.mimeType ?? "application/octet-stream");
    c.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(document.name)}"`);
    if (document.sizeBytes) c.header("Content-Length", String(document.sizeBytes));
    return stream(c, async (out) => {
      for await (const chunk of file) await out.write(chunk as Uint8Array);
    });
  });

  app.patch("/api/documents/:id", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { name } = await parseJsonBody(c, renameBodySchema);
    const document = await documentsService.rename({ userId: getUserId(c), documentId, name });
    return c.json({ document });
  });

  app.delete("/api/documents/:id", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    await documentsService.remove({ userId: getUserId(c), documentId });
    return c.body(null, 204);
  });

  app.post("/api/documents/:id/restore", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const document = await documentsService.restore({ userId: getUserId(c), documentId });
    return c.json({ document });
  });

  app.delete("/api/documents/:id/permanent", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    await documentsService.purge({ userId: getUserId(c), documentId });
    return c.body(null, 204);
  });

  app.post("/api/documents/:id/triage", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { acceptTitle } = await parseJsonBody(c, triageActionSchema);
    const document = await documentsService.acceptTriage({ userId: getUserId(c), documentId, acceptTitle });
    return c.json({ document });
  });

  app.post("/api/documents/triage", async (c) => {
    const { documentIds } = await parseJsonBody(c, triageBatchSchema);
    const result = await documentsService.acceptTriageBatch({ userId: getUserId(c), documentIds });
    return c.json(result);
  });

  app.post("/api/documents/bulk/delete", async (c) => {
    const { documentIds } = await parseJsonBody(c, bulkDeleteSchema);
    const result = await documentsService.bulkDelete({ userId: getUserId(c), documentIds });
    return c.json(result);
  });

  app.post("/api/documents/bulk/tag", async (c) => {
    if (!tagsService) return c.json({ error: "Tags service not available" }, 500);
    const { documentIds, tagId, action } = await parseJsonBody(c, bulkTagSchema);
    const userId = getUserId(c);
    let count = 0;
    for (const documentId of documentIds) {
      if (action === "add") await tagsService.setDocumentTag({ userId, documentId, tagId });
      else await tagsService.clearDocumentTag({ userId, documentId, tagId });
      count++;
    }
    return c.json({ count });
  });

  app.post("/api/documents/bulk/category", async (c) => {
    if (!tagsService) return c.json({ error: "Tags service not available" }, 500);
    const { documentIds, categoryId } = await parseJsonBody(c, bulkCategorySchema);
    const result = await documentsService.bulkCategory({ userId: getUserId(c), documentIds, categoryId });
    return c.json(result);
  });

  app.post("/api/documents/bulk/sort", async (c) => {
    if (!rulesService) return c.json({ error: "Rules service not available" }, 500);
    const { documentIds } = await parseJsonBody(c, bulkSortSchema);
    const userId = getUserId(c);
    const jobIds: string[] = [];
    for (const documentId of documentIds) {
      const job = await rulesService.requestSort({ userId, documentId });
      jobIds.push(job.id);
    }
    return c.json({ count: documentIds.length, jobIds });
  });
}
