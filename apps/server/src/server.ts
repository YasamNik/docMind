import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./modules/config/config.js";
import type { Database } from "./modules/database/database.js";
import { requireUser, sessionMiddleware } from "./modules/auth/auth.middleware.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { createAuth } from "./modules/auth/auth.services.js";
import { registerAiRoutes } from "./modules/ai/ai.routes.js";
import { createAiService } from "./modules/ai/ai.usecases.js";
import { aiProviderRegistry } from "./modules/ai/providers/index.js";
import { createOpenAiCompatibleAdapter } from "./modules/ai/adapters/openai-compatible.adapter.js";
import { createAnthropicAdapter } from "./modules/ai/adapters/anthropic.adapter.js";
import type { AdapterConfig } from "./modules/ai/adapters/adapter.types.js";
import type { AiAdapter } from "./modules/ai/ai.types.js";
import { parseModelUri } from "./modules/ai/ai.models.js";
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
import { createRulesService } from "./modules/rules/rules.usecases.js";
import { registerTagsRoutes } from "./modules/tags/tags.routes.js";
import { createTagsService } from "./modules/tags/tags.usecases.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { createError } from "./shared/errors/errors.js";

type AdapterFactories = {
  "openai-compatible": (config: AdapterConfig) => AiAdapter;
  "anthropic": (config: AdapterConfig) => AiAdapter;
};

export function createServer({
  config,
  db,
  ocrEngine = createTesseractEngine(),
  adapterFactories = { "openai-compatible": createOpenAiCompatibleAdapter, "anthropic": createAnthropicAdapter },
}: {
  config: Config;
  db: Database;
  ocrEngine?: OcrEngine;
  adapterFactories?: AdapterFactories;
}) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/api/*", cors({ origin: [config.clientBaseUrl], credentials: true }));

  const auth = createAuth({ db, config });
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(allSettingDefinitions),
    config: {
      settingsEncryptionKey: config.settingsEncryptionKey,
      env: config.env,
      beforeSet: async (userId, updates) => {
        for (const [key, value] of Object.entries(updates)) {
          if (key.startsWith("ai.model.") && typeof value === "string" && value !== "" && value !== null) {
            const { providerId } = parseModelUri(value);
            const provider = aiProviderRegistry[providerId];
            if (!provider) {
              throw createError({ code: "ai.unknown_provider", message: `Unknown provider "${providerId}"`, status: 400 });
            }
            if (provider.requiresKey) {
              // A single PUT can set the provider's key and the slot in the same batch.
              // Check the pending updates first so that combined write succeeds, and only
              // fall back to the stored setting when the batch does not touch the key.
              const apiKeyField = `ai.${providerId}.apiKey`;
              const pendingApiKey = updates[apiKeyField];
              const apiKey =
                typeof pendingApiKey === "string" && pendingApiKey !== ""
                  ? pendingApiKey
                  : await settingsService.get<string>(userId, apiKeyField);
              if (!apiKey) {
                throw createError({
                  code: "ai.provider_not_configured",
                  message: `Provider "${provider.label}" requires an API key. Set it first.`,
                  status: 400,
                });
              }
            }
            // Check capability for the slot's task
            const slot = key.replace("ai.model.", "");
            if (slot === "embedding" && !provider.capabilities.embeddings) {
              throw createError({
                code: "ai.capability_missing",
                message: `Provider "${provider.label}" does not support embeddings.`,
                status: 400,
              });
            }
            if (slot === "rules" && !provider.capabilities.structured) {
              throw createError({
                code: "ai.capability_missing",
                message: `Provider "${provider.label}" does not support structured output, which is required for the rules slot.`,
                status: 400,
              });
            }
            if (slot === "chat" && !provider.capabilities.text) {
              throw createError({
                code: "ai.capability_missing",
                message: `Provider "${provider.label}" does not support text generation, which is required for the chat slot.`,
                status: 400,
              });
            }
          }
        }
      },
    },
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
  const aiService = createAiService({ settingsService, registry: aiProviderRegistry, adapterFactories });
  const tagsService = createTagsService({ db });
  const rulesService = createRulesService({ db, aiService });
  const extractionService: ExtractionService = createExtractionService({ db, documentsService, settingsService, registry, rulesService });
  const jobRunner = createJobRunner({ db, handlers: { extraction: extractionService.handler, rules: rulesService.handler } });

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerAuthRoutes({ app, auth, db });

  app.use("/api/*", sessionMiddleware(auth));
  const getUserId = (c: Context) => requireUser(c).id;

  registerSettingsRoutes({ app, settingsService, getUserId });
  registerDocumentsRoutes({ app, documentsService, getUserId });
  registerExtractionRoutes({ app, extractionService, getUserId });
  registerJobsRoutes({ app, jobsService, getUserId });
  registerAiRoutes({ app, aiService, settingsService, getUserId });
  registerTagsRoutes({ app, tagsService, getUserId });

  return { app, auth, settingsService, storageService, documentsService, jobsService, extractionService, jobRunner, ocrEngine, aiService, tagsService, rulesService, getUserId };
}

export type Server = ReturnType<typeof createServer>;
