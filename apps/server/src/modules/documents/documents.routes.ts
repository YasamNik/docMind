import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";
import { createError } from "../../shared/errors/errors.js";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema, renameBodySchema, uploadQuerySchema } from "./documents.schemas.js";
import type { DocumentsService } from "./documents.usecases.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function registerDocumentsRoutes({
  app,
  documentsService,
  getUserId,
}: {
  app: Hono;
  documentsService: DocumentsService;
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
    const result = await documentsService.upload({ userId, name, mimeType, body });
    return c.json(result, result.duplicateOf ? 200 : 201);
  });

  app.get("/api/documents", async (c) => {
    const documents = await documentsService.list({ userId: getUserId(c) });
    return c.json({ documents });
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
}
