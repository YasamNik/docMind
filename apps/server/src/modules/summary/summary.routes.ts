import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import type { SummaryService } from "./summary.usecases.js";

export function registerSummaryRoutes({
  app,
  summaryService,
  getUserId,
}: {
  app: Hono;
  summaryService: SummaryService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/documents/:id/accept-title", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const document = await summaryService.acceptTitle({ userId: getUserId(c), documentId });
    return c.json({ document });
  });
}
