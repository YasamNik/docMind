import type { Context, Hono } from "hono";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { createSavedSearchSchema, searchQuerySchema, updateSavedSearchSchema } from "./search.schemas.js";
import type { SearchService } from "./search.usecases.js";

const DEFAULT_LIMIT = 20;

export function registerSearchRoutes({
  app,
  searchService,
  getUserId,
}: {
  app: Hono;
  searchService: SearchService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/search", async (c) => {
    const { q, limit } = parseOrValidationError(searchQuerySchema, c.req.query());
    const results = await searchService.search({ userId: getUserId(c), query: q, limit: limit ?? DEFAULT_LIMIT });
    return c.json({ results, query: q });
  });

  app.post("/api/search/reembed-all", async (c) => {
    const result = await searchService.reembedAll({ userId: getUserId(c) });
    return c.json(result);
  });

  app.get("/api/saved-searches", async (c) => {
    const searches = await searchService.listSavedSearches({ userId: getUserId(c) });
    return c.json({ searches });
  });

  app.post("/api/saved-searches", async (c) => {
    const body = await parseJsonBody(c, createSavedSearchSchema);
    const search = await searchService.createSavedSearch({ userId: getUserId(c), ...body });
    return c.json({ search }, 201);
  });

  app.patch("/api/saved-searches/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c, updateSavedSearchSchema);
    const search = await searchService.updateSavedSearch({ userId: getUserId(c), id, ...body });
    return c.json({ search });
  });

  app.delete("/api/saved-searches/:id", async (c) => {
    const id = c.req.param("id");
    await searchService.deleteSavedSearch({ userId: getUserId(c), id });
    return c.body(null, 204);
  });
}
