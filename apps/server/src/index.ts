import { serve } from "@hono/node-server";
import { loadConfig } from "./modules/config/config.js";
import { createDatabase } from "./modules/database/database.js";
import { runMigrations } from "./modules/database/database.usecases.js";
import { createServer } from "./server.js";
import { createLogger } from "./shared/logger/logger.js";

const logger = createLogger("main");
const config = loadConfig();
const { db } = await createDatabase({ url: config.databaseUrl });
await runMigrations({ db });
const { app, jobRunner, telegramService, emailService, ocrEngine } = createServer({ config, db });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "DocMind server listening");
});

await jobRunner.start();
await telegramService.start();
await emailService.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "Shutting down");
    await jobRunner.stop();
    await telegramService.stop();
    await emailService.stop();
    await ocrEngine.terminate();
    process.exit(0);
  });
}
