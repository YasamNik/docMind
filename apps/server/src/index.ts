import { serve } from "@hono/node-server";
import { loadConfig } from "./modules/config/config.js";
import { createDatabase } from "./modules/database/database.js";
import { runMigrations } from "./modules/database/database.usecases.js";
import { createServer } from "./server.js";
import { createLogger } from "./shared/logger/logger.js";

const logger = createLogger("main");
const config = loadConfig();
const { db } = createDatabase({ url: config.databaseUrl });
await runMigrations({ db });
const { app } = createServer({ config, db });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "DocMind server listening");
});
