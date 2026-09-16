import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./modules/config/config.js";
import type { Database } from "./modules/database/database.js";
import { requireUser, sessionMiddleware } from "./modules/auth/auth.middleware.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { createAuth } from "./modules/auth/auth.services.js";
import { allSettingDefinitions } from "./modules/settings/settings.definitions.js";
import { createSettingsRegistry } from "./modules/settings/settings.registry.js";
import { registerSettingsRoutes } from "./modules/settings/settings.routes.js";
import { createSettingsService } from "./modules/settings/settings.usecases.js";
import { createStorageService } from "./modules/storage/storage.usecases.js";
import { errorHandler } from "./shared/http/error-handler.js";

export function createServer({ config, db }: { config: Config; db: Database }) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/api/*", cors({ origin: [config.clientBaseUrl], credentials: true }));

  const auth = createAuth({ db, config });
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(allSettingDefinitions),
    config: { settingsEncryptionKey: config.settingsEncryptionKey, env: config.env },
  });
  const storageService = createStorageService({ settingsService });

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerAuthRoutes({ app, auth, db });

  app.use("/api/*", sessionMiddleware(auth));
  const getUserId = (c: Context) => requireUser(c).id;

  registerSettingsRoutes({ app, settingsService, getUserId });

  return { app, auth, settingsService, storageService, getUserId };
}

export type Server = ReturnType<typeof createServer>;
