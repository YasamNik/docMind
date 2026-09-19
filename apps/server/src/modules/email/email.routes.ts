import type { Context, Hono } from "hono";
import type { EmailService } from "./email.usecases.js";

// In the shape storage.routes.ts and ai.routes.ts use for their own test endpoints: no
// body to parse, the orchestration lives in the service, the route only resolves who
// is asking and hands back what the service decided.

function requestOrigin(c: Context) {
  return new URL(c.req.url).origin;
}

export function registerEmailRoutes({
  app,
  emailService,
  getUserId,
  settingsEncryptionKey,
}: {
  app: Hono;
  emailService: EmailService;
  getUserId: (c: Context) => string;
  // Only needed by the Gmail connect route below, to sign the state storage's shared
  // callback address will carry back. Optional so a caller that never wires Gmail
  // connect, such as an existing test, keeps working unchanged.
  settingsEncryptionKey?: string;
}) {
  app.post("/api/email/test", async (c) => {
    const userId = getUserId(c);
    const result = await emailService.testConnection({ userId });
    return c.json(result);
  });

  // Sends the browser to Google's consent screen. Requires a session, since this is
  // where the app learns which user is connecting. The address Google returns to is
  // storage's shared one; this button is email's own.
  app.get("/api/email/gmail/connect", async (c) => {
    if (!settingsEncryptionKey) {
      throw new Error("registerEmailRoutes was not given settingsEncryptionKey");
    }
    const userId = getUserId(c);
    const url = await emailService.buildGmailAuthorizeUrl({ userId, origin: requestOrigin(c), secretHex: settingsEncryptionKey });
    return c.redirect(url, 302);
  });
}
