import type { Context, Hono } from "hono";
import { parseJsonBody } from "../../shared/http/validate.js";
import { updateSettingsBodySchema } from "./settings.schemas.js";
import type { SettingsService } from "./settings.usecases.js";

export function registerSettingsRoutes({
  app,
  settingsService,
  getUserId,
}: {
  app: Hono;
  settingsService: SettingsService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/settings", async (c) => {
    const settings = await settingsService.listResolved(getUserId(c));
    return c.json({ settings });
  });

  app.put("/api/settings", async (c) => {
    const userId = getUserId(c);
    const { updates } = await parseJsonBody(c, updateSettingsBodySchema);
    await settingsService.set(userId, updates);
    const settings = await settingsService.listResolved(userId);
    return c.json({ settings });
  });
}
