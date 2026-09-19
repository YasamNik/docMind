import type { Context, Hono } from "hono";
import * as v from "valibot";
import { createError } from "../../shared/errors/errors.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { storageDriverIds } from "./storage.registry.js";
import { STORAGE_PURPOSE_PREFIX, verifyState } from "./storage.models.js";
import type { StorageService } from "./storage.usecases.js";

const driverIdParamSchema = v.picklist(storageDriverIds);
const oauthCallbackQuerySchema = v.object({
  code: v.pipe(v.string(), v.minLength(1)),
  state: v.pipe(v.string(), v.minLength(1)),
});

function requestOrigin(c: Context) {
  return new URL(c.req.url).origin;
}

// What a non-storage purpose's completer does with a verified callback: read whatever
// it needs off its own settings, using code, state and origin, then say where the
// browser should land. Storage imports nothing from the module that supplies one of
// these; it only calls the function it was handed, the same inversion that already
// hands storage.usecases.ts its countDocuments function.
export type OAuthCallbackCompleter = (args: { code: string; state: string; origin: string }) => Promise<{ redirectTo: string }>;

export function registerStorageRoutes({
  app,
  storageService,
  getUserId,
  settingsEncryptionKey,
  // Purpose-keyed completers for a callback that is not a storage connection, for
  // example "email:gmail". This is a route registration argument, not a
  // createStorageService one: server.ts builds emailService and other feature
  // services before it registers any routes, so route registration time already has
  // whatever completer a feature wants to offer, while building the table into
  // storage's own constructor would require every such feature to exist before
  // storage does, an ordering this codebase does not guarantee.
  completers = {},
}: {
  app: Hono;
  storageService: StorageService;
  getUserId: (c: Context) => string;
  settingsEncryptionKey: string;
  completers?: Record<string, OAuthCallbackCompleter>;
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
  // comes only from the signed state, never from getUserId. The address is shared by
  // every feature that reuses this Google app, so this route also dispatches on the
  // state's purpose: a storage purpose completes here as it always has, anything else
  // goes to whatever completer was registered for it.
  app.get("/api/storage/drivers/:id/callback", async (c) => {
    const driverId = parseOrValidationError(driverIdParamSchema, c.req.param("id"));
    const { code, state } = parseOrValidationError(oauthCallbackQuerySchema, {
      code: c.req.query("code"),
      state: c.req.query("state"),
    });
    const origin = requestOrigin(c);

    // Signature and TTL are checked right here, before anything decides where this
    // callback goes. The purpose read out of it is only ever a routing hint though:
    // whichever branch below runs still verifies the state again for itself, so
    // nothing this route decides can weaken what a completer checks.
    const { purpose } = verifyState({ state, secretHex: settingsEncryptionKey });

    if (purpose.startsWith(STORAGE_PURPOSE_PREFIX)) {
      const { driverId: connectedDriverId } = await storageService.completeOAuthConnection({
        driverId,
        code,
        state,
        origin,
        secretHex: settingsEncryptionKey,
      });
      return c.redirect(`/settings?tab=storage&connected=${connectedDriverId}`, 302);
    }

    // A purpose that names neither storage nor a registered completer is exactly as
    // untrustworthy as a state that failed to verify at all: it must never reach a
    // completer call this route has not confirmed exists.
    const completer = completers[purpose];
    if (!completer) {
      throw createError({ code: "storage.invalid_state", message: "Invalid oauth state", status: 400 });
    }
    const { redirectTo } = await completer({ code, state, origin });
    return c.redirect(redirectTo, 302);
  });
}
