import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { providerIdSchema } from "./ai.schemas.js";
import { MODEL_SLOTS } from "./ai.models.js";
import { aiProviderRegistry, aiProviderIds } from "./providers/index.js";
import type { AiService } from "./ai.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { createError } from "../../shared/errors/errors.js";

export function registerAiRoutes({
  app,
  aiService,
  settingsService,
  getUserId,
}: {
  app: Hono;
  aiService: AiService;
  settingsService: SettingsService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/ai/providers", async (c) => {
    const userId = getUserId(c);

    const providers = await Promise.all(
      aiProviderIds.map(async (id) => {
        const def = aiProviderRegistry[id]!;
        const keyResolved = def.settings.find((s) => s.key.endsWith(".apiKey"))
          ? await settingsService.getResolved(userId, `ai.${id}.apiKey`)
          : null;
        const hasBaseUrlSetting = def.settings.some((s) => s.key === `ai.${id}.baseUrl`);
        const baseUrlResolved = hasBaseUrlSetting
          ? await settingsService.getResolved(userId, `ai.${id}.baseUrl`)
          : null;

        return {
          id: def.id,
          label: def.label,
          adapter: def.adapter,
          defaultBaseUrl: def.defaultBaseUrl,
          requiresKey: def.requiresKey,
          capabilities: def.capabilities,
          suggestedModels: def.suggestedModels,
          guide: def.guide,
          keySet: keyResolved ? (keyResolved.value as { isSet: boolean }).isSet : false,
          keyLastFour: keyResolved ? (keyResolved.value as { lastFour?: string }).lastFour : undefined,
          baseUrl: baseUrlResolved
            ? { value: baseUrlResolved.value as string, source: baseUrlResolved.source }
            : { value: def.defaultBaseUrl, source: "default" as const },
        };
      }),
    );

    const slots: Record<string, unknown> = {};
    for (const slot of MODEL_SLOTS) {
      const resolved = await settingsService.getResolved(userId, `ai.model.${slot}`);
      // Find the suggestion for this slot from the first configured provider
      let suggestion: string | undefined;
      for (const id of aiProviderIds) {
        const def = aiProviderRegistry[id]!;
        const suggested = def.suggestedModels[slot];
        if (!suggested) continue;
        if (!def.requiresKey) {
          suggestion = `${id}://${suggested}`;
          break;
        }
        const keyRes = await settingsService.getResolved(userId, `ai.${id}.apiKey`);
        if ((keyRes.value as { isSet: boolean }).isSet) {
          suggestion = `${id}://${suggested}`;
          break;
        }
      }
      slots[slot] = { value: resolved.value, source: resolved.source, suggestion };
    }

    return c.json({ providers, slots });
  });

  app.post("/api/ai/providers/:id/test", async (c) => {
    const id = parseOrValidationError(providerIdSchema, c.req.param("id"));
    if (!aiProviderRegistry[id]) {
      throw createError({ code: "ai.unknown_provider", message: `Unknown provider "${id}"`, status: 400 });
    }
    const userId = getUserId(c);
    const result = await aiService.testConnection(userId, id);
    return c.json(result);
  });

  app.get("/api/ai/providers/:id/models", async (c) => {
    const id = parseOrValidationError(providerIdSchema, c.req.param("id"));
    if (!aiProviderRegistry[id]) {
      throw createError({ code: "ai.unknown_provider", message: `Unknown provider "${id}"`, status: 400 });
    }
    const userId = getUserId(c);
    const result = await aiService.listModels(userId, id);
    return c.json(result);
  });
}
