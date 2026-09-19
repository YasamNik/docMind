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

async function makeApp(clientFactory: EmailClientFactory) {
  const { db } = await createTestDatabase();
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry([...storageSettingDefinitions, ...emailSettingDefinitions]),
    config: { settingsEncryptionKey: "44".repeat(32), env: {} },
  });
  const storageService = createStorageService({ settingsService, countDocuments: async () => 0 });
  const documentsService = createDocumentsService({ db, storageService });
  const emailService = createEmailService({
    settingsService,
    documentsService,
    getUserId: async () => userId,
    clientFactory,
  });

  const app = new Hono();
  app.onError(errorHandler);
  registerEmailRoutes({ app, emailService, getUserId: () => userId });
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
