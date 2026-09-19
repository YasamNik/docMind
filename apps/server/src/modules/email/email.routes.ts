import type { Context, Hono } from "hono";
import type { EmailService } from "./email.usecases.js";

// One route, in the shape storage.routes.ts and ai.routes.ts use for their own test
// endpoints: no body to parse, the orchestration lives in the service, the route only
// resolves who is asking and hands back what the service decided.

export function registerEmailRoutes({
  app,
  emailService,
  getUserId,
}: {
  app: Hono;
  emailService: EmailService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/email/test", async (c) => {
    const userId = getUserId(c);
    const result = await emailService.testConnection({ userId });
    return c.json(result);
  });
}
