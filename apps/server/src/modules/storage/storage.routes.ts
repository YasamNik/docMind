import type { Context, Hono } from "hono";
import * as v from "valibot";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { storageDriverIds } from "./storage.registry.js";
import type { StorageService } from "./storage.usecases.js";

const driverIdParamSchema = v.picklist(storageDriverIds);
const oauthCallbackQuerySchema = v.object({
  code: v.pipe(v.string(), v.minLength(1)),
  state: v.pipe(v.string(), v.minLength(1)),
});

function requestOrigin(c: Context) {
  return new URL(c.req.url).origin;
}

export function registerStorageRoutes({
  app,
  storageService,
  getUserId,
  settingsEncryptionKey,
}: {
  app: Hono;
  storageService: StorageService;
  getUserId: (c: Context) => string;
  settingsEncryptionKey: string;
}) {
  app.get("/api/storage/drivers", async (c) => {
    const drivers = await storageService.listDriverSummaries(getUserId(c), { origin: requestOrigin(c) });
    return c.json({ drivers });
  });

  app.post("/api/storage/drivers/:id/test", async (c) => {
    const driverId = parseOrValidationError(driverIdParamSchema, c.req.param("id"));
    const result = await storageService.testDriver({ userId: getUserId(c), driverId });
    return c.json(result);
  });

  // Sends the browser on to the provider's consent screen. Requires a session, since
  // this is where the app learns which user is connecting.
  app.get("/api/storage/drivers/:id/connect", async (c) => {
    const driverId = parseOrValidationError(driverIdParamSchema, c.req.param("id"));
    const url = await storageService.buildAuthorizeUrl({
      userId: getUserId(c),
      driverId,
      origin: requestOrigin(c),
      secretHex: settingsEncryptionKey,
    });
    return c.redirect(url, 302);
  });

  // The provider's redirect back. It carries no session cookie of its own, so identity
  // comes only from the signed state, never from getUserId.
  app.get("/api/storage/drivers/:id/callback", async (c) => {
    const driverId = parseOrValidationError(driverIdParamSchema, c.req.param("id"));
    const { code, state } = parseOrValidationError(oauthCallbackQuerySchema, {
      code: c.req.query("code"),
      state: c.req.query("state"),
    });
    const { driverId: connectedDriverId } = await storageService.completeOAuthConnection({
      driverId,
      code,
      state,
      origin: requestOrigin(c),
      secretHex: settingsEncryptionKey,
    });
    return c.redirect(`/settings?tab=storage&connected=${connectedDriverId}`, 302);
  });
}
