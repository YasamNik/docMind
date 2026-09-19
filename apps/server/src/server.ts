import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Config } from "./modules/config/config.js";
import type { Database } from "./modules/database/database.js";
import { requireUser, sessionMiddleware } from "./modules/auth/auth.middleware.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { createAuth } from "./modules/auth/auth.services.js";
import { user as authUserTable } from "./modules/auth/auth.tables.js";
import { registerAiRoutes } from "./modules/ai/ai.routes.js";
import { createAiService } from "./modules/ai/ai.usecases.js";
import { aiProviderRegistry } from "./modules/ai/providers/index.js";
import { createOpenAiCompatibleAdapter } from "./modules/ai/adapters/openai-compatible.adapter.js";
import { createAnthropicAdapter } from "./modules/ai/adapters/anthropic.adapter.js";
import type { AdapterConfig } from "./modules/ai/adapters/adapter.types.js";
import type { AiAdapter } from "./modules/ai/ai.types.js";
import { parseModelUri } from "./modules/ai/ai.models.js";
import { registerDocumentsRoutes } from "./modules/documents/documents.routes.js";
import { createDocumentsRepository } from "./modules/documents/documents.repository.js";
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
import { registerFieldsRoutes } from "./modules/fields/fields.routes.js";
import { createFieldsRepository } from "./modules/fields/fields.repository.js";
import { registerJobsRoutes } from "./modules/jobs/jobs.routes.js";
import { createJobRunner } from "./modules/jobs/jobs.runner.js";
import { createJobsService } from "./modules/jobs/jobs.usecases.js";
import { allSettingDefinitions } from "./modules/settings/settings.definitions.js";
import { createSettingsRegistry } from "./modules/settings/settings.registry.js";
import { registerSettingsRoutes } from "./modules/settings/settings.routes.js";
import { createSettingsService } from "./modules/settings/settings.usecases.js";
import { registerStorageRoutes } from "./modules/storage/storage.routes.js";
import { createStorageService } from "./modules/storage/storage.usecases.js";
import { registerRulesRoutes } from "./modules/rules/rules.routes.js";
import { createRulesService } from "./modules/rules/rules.usecases.js";
import { registerChatRoutes } from "./modules/chat/chat.routes.js";
import { createChatService } from "./modules/chat/chat.usecases.js";
import { registerAssistantRoutes } from "./modules/assistant/assistant.routes.js";
import { createAssistantService } from "./modules/assistant/assistant.usecases.js";
import { registerSearchRoutes } from "./modules/search/search.routes.js";
import { createSearchService } from "./modules/search/search.usecases.js";
import { registerSummaryRoutes } from "./modules/summary/summary.routes.js";
import { createSummaryService } from "./modules/summary/summary.usecases.js";
import { registerTelegramRoutes } from "./modules/telegram/telegram.routes.js";
import { createTelegramService } from "./modules/telegram/telegram.usecases.js";
import { createEmailService } from "./modules/email/email.usecases.js";
import { registerEmailRoutes } from "./modules/email/email.routes.js";
import { registerTagsRoutes } from "./modules/tags/tags.routes.js";
import { createTagsService } from "./modules/tags/tags.usecases.js";
import { registerExportRoutes } from "./modules/export/export.routes.js";
import { createExportService } from "./modules/export/export.usecases.js";
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
            if (slot === "vision" && !provider.capabilities.vision) {
              throw createError({
                code: "ai.capability_missing",
                message: `Provider "${provider.label}" does not support image inputs, which is required for the vision slot.`,
                status: 400,
              });
            }
          }
        }
      },
    },
  });
  // Storage is a foundational module and does not depend on documents. The count it
  // needs per driver is supplied here from the documents repository instead.
  const documentsRepository = createDocumentsRepository({ db });
  const storageService = createStorageService({
    settingsService,
    countDocuments: ({ userId, storageDriver }) => documentsRepository.countByUser({ userId, view: "all", storageDriver }),
  });
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
  const tagsService = createTagsService({ db, aiService, settingsService });
  const rulesService = createRulesService({ db, aiService, documentsService, tagsService });
  const extractionService: ExtractionService = createExtractionService({ db, documentsService, settingsService, registry, rulesService, aiService, storageService });
  const searchService = createSearchService({ db, aiService, settingsService });
  const summaryService = createSummaryService({ db, aiService });
  const fieldsRepository = createFieldsRepository({ db });
  const chatService = createChatService({ db, aiService, searchService });
  // allowWritingTools stays at its default of false (Decision 1 in the assistant
  // triage plan) until chat_sessions.pending_tool_call exists.
  const assistantService = createAssistantService({ chatService, documentsService, aiService, settingsService });
  const jobRunner = createJobRunner({
    db,
    handlers: { extraction: extractionService.handler, rules: rulesService.handler, embedding: searchService.handler, summarize: summaryService.handler },
  });
  // Own long polling loop, not a job: getUpdates holds a connection open for up to
  // pollTimeoutSeconds, which does not fit the job runner's discrete-task model. There
  // is exactly one account, and this loop has no HTTP session to read it from, so it
  // resolves the sole signed-up user itself, fresh every cycle, the same way it
  // re-reads the bot token every cycle.
  const telegramService = createTelegramService({
    db,
    settingsService,
    documentsService,
    chatService,
    assistantService,
    getUserId: async () => {
      const [row] = await db.select({ id: authUserTable.id }).from(authUserTable).limit(1);
      return row?.id;
    },
    appBaseUrl: config.clientBaseUrl,
  });
  // Same shape as telegramService just above: its own loop rather than a job, one
  // account with no HTTP session to read it from, settings and credentials re-read
  // fresh every cycle so saving a password starts it and clearing one stops it.
  const emailService = createEmailService({
    settingsService,
    documentsService,
    getUserId: async () => {
      const [row] = await db.select({ id: authUserTable.id }).from(authUserTable).limit(1);
      return row?.id;
    },
  });

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  registerAuthRoutes({ app, auth, db });

  app.use("/api/*", sessionMiddleware(auth));
  const getUserId = (c: Context) => requireUser(c).id;

  registerSettingsRoutes({ app, settingsService, getUserId });
  registerDocumentsRoutes({ app, documentsService, tagsService, rulesService, getUserId });
  registerExtractionRoutes({ app, extractionService, getUserId });
  registerJobsRoutes({ app, jobsService, getUserId });
  registerAiRoutes({ app, aiService, settingsService, getUserId });
  registerTagsRoutes({ app, tagsService, rulesService, getUserId });
  registerRulesRoutes({ app, rulesService, getUserId });
  registerSearchRoutes({ app, searchService, getUserId });
  registerSummaryRoutes({ app, summaryService, getUserId });
  registerFieldsRoutes({ app, fieldsRepository, summaryService, getUserId });
  registerChatRoutes({ app, chatService, getUserId });
  registerStorageRoutes({ app, storageService, getUserId, settingsEncryptionKey: config.settingsEncryptionKey });
  registerTelegramRoutes({ app, settingsService, getUserId });
  registerAssistantRoutes({ app, assistantService, getUserId });
  registerEmailRoutes({ app, emailService, getUserId });

  const exportService = createExportService({ db, storageService });
  registerExportRoutes({ app, exportService, getUserId });

  const here = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(here, "../../client/dist");
  if (existsSync(resolve(clientDist, "index.html"))) {
    app.use("*", serveStatic({ root: resolve(here, "../../client/dist") }));
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      const html = await readFile(resolve(clientDist, "index.html"), "utf-8");
      return c.html(html);
    });
  }

  return {
    app,
    auth,
    settingsService,
    storageService,
    documentsService,
    jobsService,
    extractionService,
    jobRunner,
    telegramService,
    emailService,
    ocrEngine,
    aiService,
    tagsService,
    rulesService,
    searchService,
    summaryService,
    fieldsRepository,
    chatService,
    assistantService,
    getUserId,
  };
}

export type Server = ReturnType<typeof createServer>;
