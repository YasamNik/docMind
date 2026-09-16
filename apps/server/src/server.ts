import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./modules/config/config.js";
import type { Database } from "./modules/database/database.js";
import { requireUser, sessionMiddleware } from "./modules/auth/auth.middleware.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { createAuth } from "./modules/auth/auth.services.js";
import { registerDocumentsRoutes } from "./modules/documents/documents.routes.js";
import { createDocumentsService } from "./modules/documents/documents.usecases.js";
import { createImageExtractor } from "./modules/extraction/extractors/image.extractor.js";
import { docxExtractor } from "./modules/extraction/extractors/docx.extractor.js";
import { pdfExtractor } from "./modules/extraction/extractors/pdf.extractor.js";
import { pptxExtractor } from "./modules/extraction/extractors/pptx.extractor.js";
import { textExtractor } from "./modules/extraction/extractors/text.extractor.js";
import { xlsxExtractor } from "./modules/extraction/extractors/xlsx.extractor.js";
import { createExtractorRegistry } from "./modules/extraction/extraction.registry.js";
import { registerExtractionRoutes } from "./modules/extraction/extraction.routes.js";
import { createExtractionService, type ExtractionService } from "./modules/extraction/extraction.usecases.js";
import { createTesseractEngine, type OcrEngine } from "./modules/extraction/ocr.js";
import { registerJobsRoutes } from "./modules/jobs/jobs.routes.js";
import { createJobRunner } from "./modules/jobs/jobs.runner.js";
import { createJobsService } from "./modules/jobs/jobs.usecases.js";
import { allSettingDefinitions } from "./modules/settings/settings.definitions.js";
import { createSettingsRegistry } from "./modules/settings/settings.registry.js";
import { registerSettingsRoutes } from "./modules/settings/settings.routes.js";
import { createSettingsService } from "./modules/settings/settings.usecases.js";
import { createStorageService } from "./modules/storage/storage.usecases.js";
import { errorHandler } from "./shared/http/error-handler.js";

export function createServer({ config, db, ocrEngine = createTesseractEngine() }: { config: Config; db: Database; ocrEngine?: OcrEngine }) {
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
  const registry = createExtractorRegistry([textExtractor, pdfExtractor, docxExtractor, xlsxExtractor, pptxExtractor, createImageExtractor(ocrEngine)]);
  const jobsService = createJobsService({ db });
  const documentsService = createDocumentsService({
    db,
    storageService,
    onUploaded: async ({ userId, document, tx }) => {
      await jobsService.enqueue({ userId, type: "extraction", payload: { documentId: document.id, userId }, tx });
    },
  });
  const extractionService: ExtractionService = createExtractionService({ db, documentsService, settingsService, registry });
  const jobRunner = createJobRunner({ db, handlers: { extraction: extractionService.handler } });

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerAuthRoutes({ app, auth, db });

  app.use("/api/*", sessionMiddleware(auth));
  const getUserId = (c: Context) => requireUser(c).id;

  registerSettingsRoutes({ app, settingsService, getUserId });
  registerDocumentsRoutes({ app, documentsService, getUserId });
  registerExtractionRoutes({ app, extractionService, getUserId });
  registerJobsRoutes({ app, jobsService, getUserId });

  return { app, auth, settingsService, storageService, documentsService, jobsService, extractionService, jobRunner, ocrEngine, getUserId };
}

export type Server = ReturnType<typeof createServer>;
