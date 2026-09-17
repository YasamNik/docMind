import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { searchQuerySchema } from "./search.schemas.js";
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
}
