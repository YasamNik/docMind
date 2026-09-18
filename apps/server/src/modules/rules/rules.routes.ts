import type { Context, Hono } from "hono";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import { present } from "../jobs/jobs.models.js";
import {
  applyProposalsBodySchema,
  dryRunBodySchema,
  listProposalsQuerySchema,
  runScopeBodySchema,
  scopeQuerySchema,
} from "./rules.schemas.js";
import type { RulesService } from "./rules.usecases.js";

export function registerRulesRoutes({
  app,
  rulesService,
  getUserId,
}: {
  app: Hono;
  rulesService: RulesService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/documents/:id/sort", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const job = await rulesService.requestSort({ userId: getUserId(c), documentId });
    return c.json({ job: present(job) });
  });

  app.get("/api/documents/:id/proposals", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const proposals = await rulesService.listProposalsForDocument({ userId: getUserId(c), documentId });
    return c.json({ proposals });
  });

  app.post("/api/sort/run", async (c) => {
    const userId = getUserId(c);
    const body = await parseJsonBody(c, runScopeBodySchema);
    const result = await rulesService.runOnScope({ userId, ...body });
    return c.json(result);
  });

  app.get("/api/sort/count", async (c) => {
    const { scope } = parseOrValidationError(scopeQuerySchema, c.req.query());
    const count = await rulesService.countForScope({ userId: getUserId(c), scope });
    return c.json({ count });
  });

  app.post("/api/sort/dry-run", async (c) => {
    const userId = getUserId(c);
    const body = await parseJsonBody(c, dryRunBodySchema);
    const result = await rulesService.dryRun({ userId, ...body });
    return c.json(result);
  });

  app.get("/api/proposals", async (c) => {
    const { limit, cursor } = parseOrValidationError(listProposalsQuerySchema, c.req.query());
    const result = await rulesService.listProposals({ userId: getUserId(c), limit, cursor });
    return c.json(result);
  });

  app.post("/api/proposals/apply", async (c) => {
    const userId = getUserId(c);
    const body = await parseJsonBody(c, applyProposalsBodySchema);
    const result = await rulesService.applyProposals({ userId, ...body });
    return c.json(result);
  });

  app.post("/api/sort/suggest", async (c) => {
    const result = await rulesService.suggestRules({ userId: getUserId(c) });
    return c.json(result);
  });

  app.get("/api/documents/:id/evaluations", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const evaluations = await rulesService.listEvaluationsForDocument({ userId: getUserId(c), documentId });
    return c.json({ evaluations });
  });
}
