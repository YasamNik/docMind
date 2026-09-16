import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import type { ExtractionService } from "./extraction.usecases.js";

export function registerExtractionRoutes({
  app,
  extractionService,
  getUserId,
}: {
  app: Hono;
  extractionService: ExtractionService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/documents/:id/extract", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const job = await extractionService.requestExtraction({ userId: getUserId(c), documentId });
    return c.json({ job: { ...job, payload: JSON.parse(job.payload) } }, 202);
  });
}
