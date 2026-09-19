import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createError } from "../../shared/errors/errors.js";
import { errorHandler } from "../../shared/http/error-handler.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createDocumentsService } from "../documents/documents.usecases.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import type { ImapClient } from "./email.client.js";
import { registerEmailRoutes } from "./email.routes.js";
import { emailSettingDefinitions } from "./email.settings.js";
import { createEmailService, type EmailClientFactory } from "./email.usecases.js";

const userId = "user-1";

// A fake at the same seam email.usecases.test.ts uses for the loop: EmailClientFactory
// itself, never imapflow or a socket. The route delegates to the same emailService the
// loop runs on, so its test double belongs at the same level.
function fakeClient(overrides: Partial<ImapClient> = {}): ImapClient {
  return {
    listFolder: async () => [],
    fetchMessage: async () => {
      throw new Error("not used by the connection test");
    },
    moveMessage: async () => {},
    ensureFolder: async () => {},
    close: async () => {},
    ...overrides,
  };
}

const SETTINGS_ENCRYPTION_KEY = "44".repeat(32);

async function makeApp(clientFactory: EmailClientFactory, overrides: Partial<Parameters<typeof createEmailService>[0]> = {}) {
  const { db } = await createTestDatabase();
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry([...storageSettingDefinitions, ...emailSettingDefinitions]),
    config: { settingsEncryptionKey: SETTINGS_ENCRYPTION_KEY, env: {} },
  });
  const storageService = createStorageService({ settingsService, countDocuments: async () => 0 });
  const documentsService = createDocumentsService({ db, storageService });
  const emailService = createEmailService({
    settingsService,
    documentsService,
    getUserId: async () => userId,
    clientFactory,
    ...overrides,
  });

  const app = new Hono();
  app.onError(errorHandler);
  registerEmailRoutes({ app, emailService, getUserId: () => userId, settingsEncryptionKey: SETTINGS_ENCRYPTION_KEY });
  return { app, settingsService };
}

async function configureImap(settingsService: Awaited<ReturnType<typeof makeApp>>["settingsService"], overrides: Record<string, unknown> = {}) {
  await settingsService.set(userId, {
    "email.imap.host": "imap.example.com",
    "email.imap.user": "me@example.com",
    "email.imap.password": "an-app-password",
    ...overrides,
  });
}

describe("email routes", () => {
  it("refuses to test when the settings are incomplete, naming what is missing", async () => {
    const { app } = await makeApp(async () => fakeClient());

    const res = await app.request("/api/email/test", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; message: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/host/i);
    expect(body.message).toMatch(/mailbox address/i);
    expect(body.message).toMatch(/app password/i);
  });

  it("names only the settings that are actually missing", async () => {
    const { app, settingsService } = await makeApp(async () => fakeClient());
    await settingsService.set(userId, { "email.imap.host": "imap.example.com" });

    const res = await app.request("/api/email/test", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; message: string };

    expect(body.ok).toBe(false);
    expect(body.message).not.toMatch(/host/i);
    expect(body.message).toMatch(/mailbox address/i);
    expect(body.message).toMatch(/app password/i);
  });

  it("connects and reports how many messages are waiting", async () => {
    const { app, settingsService } = await makeApp(async () =>
      fakeClient({ listFolder: async () => [{ uid: 1 }, { uid: 2 }, { uid: 3 }] }),
    );
    await configureImap(settingsService);

    const res = await app.request("/api/email/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Connected. 3 messages waiting." });
  });

  it("reports zero messages without treating it as a failure", async () => {
    const { app, settingsService } = await makeApp(async () => fakeClient());
    await configureImap(settingsService);

    const res = await app.request("/api/email/test", { method: "POST" });

    expect(await res.json()).toEqual({ ok: true, message: "Connected. 0 messages waiting." });
  });

  it("a wrong password produces a useful message that never contains the password", async () => {
    const password = "the-real-password-do-not-leak";
    const { app, settingsService } = await makeApp(async () => {
      throw createError({ code: "email.imap_error", message: "IMAP connect to imap.example.com: authentication failed", status: 502 });
    });
    await configureImap(settingsService, { "email.imap.password": password });

    const res = await app.request("/api/email/test", { method: "POST" });
    const text = await res.text();
    const body = JSON.parse(text) as { ok: boolean; message: string };

    expect(res.status).toBe(200);
    expect(text).not.toContain(password);
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/sign-in failed/i);
  });

  it("reports a bad host differently from a bad password", async () => {
    const { app, settingsService } = await makeApp(async () => {
      throw createError({ code: "email.imap_error", message: "IMAP connect to typo.example.com: could not resolve the host", status: 502 });
    });
    await configureImap(settingsService, { "email.imap.host": "typo.example.com" });

    const res = await app.request("/api/email/test", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; message: string };

    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/typo\.example\.com/);
    expect(body.message).not.toMatch(/sign-in failed/i);
  });

  it("reports a missing watched folder differently from a bad host or password", async () => {
    const { app, settingsService } = await makeApp(async () =>
      fakeClient({
        listFolder: async () => {
          throw createError({ code: "email.imap_error", message: "IMAP mailboxOpen to imap.example.com: the folder does not exist", status: 502 });
        },
      }),
    );
    await configureImap(settingsService, { "email.imap.folder": "NoSuchFolder" });

    const res = await app.request("/api/email/test", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; message: string };

    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/NoSuchFolder/);
    expect(body.message).not.toMatch(/sign-in failed/i);
    expect(body.message).not.toMatch(/resolve the host/i);
  });

  it("falls back to a plain message for an error it does not recognize, and never forwards it raw", async () => {
    const { app, settingsService } = await makeApp(async () => {
      throw new Error("ECONNRESET at socket layer, dumped by an unrelated library");
    });
    await configureImap(settingsService);

    const res = await app.request("/api/email/test", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; message: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).not.toContain("ECONNRESET");
    expect(body.message.length).toBeGreaterThan(0);
  });
});

function gmailRedirectUri({ origin }: { origin: string }): string {
  return `${origin}/api/storage/drivers/googleDrive/callback`;
}

describe("gmail connect route", () => {
  it("sends the browser to Google carrying the three scopes and no secret", async () => {
    const { app } = await makeApp(async () => fakeClient(), {
      buildRedirectUri: gmailRedirectUri,
      getSharedGoogleApp: async () => ({ clientId: "shared-id", clientSecret: "leaked-shared-secret" }),
    });

    const res = await app.request("/api/email/gmail/connect", { redirect: "manual" });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe("shared-id");
    expect(location.searchParams.get("scope")).toBe("https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email");
    expect(location.searchParams.get("state")).toMatch(/\./);
    expect(res.headers.get("location")).not.toContain("leaked-shared-secret");
  });

  it("returns a clear 400 with no Google app configured anywhere", async () => {
    const { app } = await makeApp(async () => fakeClient(), { buildRedirectUri: gmailRedirectUri });

    const res = await app.request("/api/email/gmail/connect");

    expect(res.status).toBe(400);
  });

  it("returns a clear 400 for a half set override", async () => {
    const { app, settingsService } = await makeApp(async () => fakeClient(), { buildRedirectUri: gmailRedirectUri });
    await settingsService.set(userId, { "email.gmail.clientId": "override-id" });

    const res = await app.request("/api/email/gmail/connect");

    expect(res.status).toBe(400);
  });
});

describe("email status route", () => {
  it("reports the resolved mode and the redirect uri, with no secret anywhere in the body", async () => {
    const { app, settingsService } = await makeApp(async () => fakeClient(), { buildRedirectUri: gmailRedirectUri });
    await settingsService.set(userId, {
      "email.gmail.clientId": "override-id",
      "email.gmail.clientSecret": "leaked-client-secret",
      "email.gmail.refreshToken": "leaked-refresh-token",
      "email.gmail.accountEmail": "me@gmail.com",
    });

    const res = await app.request("/api/email/status");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.mode).toBe("gmail");
    expect(body.connectedAs).toBe("me@gmail.com");
    expect(body.redirectUri).toBe("http://localhost/api/storage/drivers/googleDrive/callback");
    expect(body.needsReconnect).toBe(false);
    expect(text).not.toContain("leaked-client-secret");
    expect(text).not.toContain("leaked-refresh-token");
    expect(Object.keys(body)).not.toContain("clientSecret");
    expect(Object.keys(body)).not.toContain("refreshToken");
  });

  it("reports unconfigured with no google app available when nothing is set", async () => {
    const { app } = await makeApp(async () => fakeClient(), { buildRedirectUri: gmailRedirectUri });

    const res = await app.request("/api/email/status");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.mode).toBe("unconfigured");
    expect(body.googleAppAvailable).toBe(false);
  });
});
