import { api } from "./api";

export type EmailTestResult = { ok: boolean; message: string };

// Matches EmailStatus in email.usecases.ts: what GET /api/email/status returns for the
// Email tab to render itself from. Never a secret, a password or a token.
export type EmailStatus = {
  mode: "gmail" | "password" | "unconfigured";
  connectedAs?: string;
  googleAppAvailable: boolean;
  redirectUri: string;
  needsReconnect: boolean;
  lastError?: string;
};

export const emailApi = {
  async test() {
    return api.json<EmailTestResult>("POST", "/api/email/test", {});
  },
  async status() {
    return api.get<EmailStatus>("/api/email/status");
  },
};
