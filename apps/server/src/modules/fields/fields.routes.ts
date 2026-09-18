import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import type { SummaryService } from "../summary/summary.usecases.js";
import type { FieldsRepository } from "./fields.repository.js";
import { fieldKeyQuerySchema } from "./fields.schemas.js";

export function registerFieldsRoutes({
  app,
  fieldsRepository,
  summaryService,
  getUserId,
}: {
  app: Hono;
  fieldsRepository: FieldsRepository;
  // The backfill endpoint lives here for URL tidiness but the job logic belongs to
  // summary, which owns the summarize job. The fields module stays job-agnostic.
  summaryService: Pick<SummaryService, "enqueueBackfill">;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/documents/:id/fields", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const fields = await fieldsRepository.listByDocument({ userId: getUserId(c), documentId });
    return c.json({ fields });
  });

  app.get("/api/fields/values", async (c) => {
    const key = parseOrValidationError(fieldKeyQuerySchema, c.req.query("key"));
    const values = await fieldsRepository.listDistinctValues({ userId: getUserId(c), key });
    return c.json({ values });
  });

  app.post("/api/fields/backfill", async (c) => {
    const result = await summaryService.enqueueBackfill({ userId: getUserId(c) });
    return c.json(result);
  });
}
