import type { Context, Hono } from "hono";
import * as v from "valibot";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { storageDriverIds } from "./storage.registry.js";
import type { StorageService } from "./storage.usecases.js";

const driverIdParamSchema = v.picklist(storageDriverIds);

export function registerStorageRoutes({
  app,
  storageService,
  getUserId,
}: {
  app: Hono;
  storageService: StorageService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/storage/drivers", async (c) => {
    const drivers = await storageService.listDriverSummaries(getUserId(c));
    return c.json({ drivers });
  });

  app.post("/api/storage/drivers/:id/test", async (c) => {
    const driverId = parseOrValidationError(driverIdParamSchema, c.req.param("id"));
    const result = await storageService.testDriver({ userId: getUserId(c), driverId });
    return c.json(result);
  });
}
