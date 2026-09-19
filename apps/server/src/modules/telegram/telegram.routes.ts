import type { Context, Hono } from "hono";
import { createError } from "../../shared/errors/errors.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { newPairingCode } from "./telegram.models.js";

// The status, pairing-code and unpair routes read and write telegram settings
// directly, the same way registerSettingsRoutes reads and writes through
// settingsService with no usecases layer between: there is no orchestration here
// beyond a few setting reads and writes.

async function issuePairingCode(settingsService: SettingsService, userId: string): Promise<string> {
  const token = await settingsService.get<string>(userId, "telegram.botToken");
  if (!token) {
    throw createError({
      code: "telegram.token_not_set",
      message: "Set a bot token before requesting a pairing code.",
      status: 400,
    });
  }
  const code = newPairingCode();
  await settingsService.setInternal(userId, "telegram.pairingCode", code);
  return code;
}

async function ensurePairingCode(settingsService: SettingsService, userId: string): Promise<string> {
  const existing = await settingsService.get<string>(userId, "telegram.pairingCode");
  if (existing) return existing;
  return issuePairingCode(settingsService, userId);
}

export function registerTelegramRoutes({
  app,
  settingsService,
  getUserId,
}: {
  app: Hono;
  settingsService: SettingsService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/telegram/status", async (c) => {
    const userId = getUserId(c);
    const token = await settingsService.get<string>(userId, "telegram.botToken");
    const tokenSet = Boolean(token);
    const pairedUserId = await settingsService.get<number>(userId, "telegram.pairedUserId");
    const paired = pairedUserId !== undefined;

    if (!tokenSet) return c.json({ tokenSet, paired });

    if (paired) {
      const pairedName = await settingsService.get<string>(userId, "telegram.pairedName");
      return c.json({ tokenSet, paired, pairedName: pairedName || undefined });
    }

    const pairingCode = await ensurePairingCode(settingsService, userId);
    return c.json({ tokenSet, paired, pairingCode });
  });

  app.post("/api/telegram/pairing-code", async (c) => {
    const userId = getUserId(c);
    const pairingCode = await issuePairingCode(settingsService, userId);
    return c.json({ pairingCode });
  });

  app.post("/api/telegram/unpair", async (c) => {
    const userId = getUserId(c);
    await settingsService.removeInternal(userId, "telegram.pairedUserId");
    await settingsService.setInternal(userId, "telegram.pairedName", "");

    // Leaves a fresh code ready right away so the page shows a usable one on its next
    // status fetch, without the visitor having to press "get a new code" themselves.
    const token = await settingsService.get<string>(userId, "telegram.botToken");
    if (token) await issuePairingCode(settingsService, userId);

    return c.json({ ok: true });
  });
}
