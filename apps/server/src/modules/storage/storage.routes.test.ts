import { Readable } from "node:stream";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { googleDriveDriverDefinition } from "./drivers/google-drive/google-drive.driver.js";
import { signOAuthState, signState } from "./storage.models.js";
import { registerStorageRoutes, type OAuthCallbackCompleter } from "./storage.routes.js";
import { createStorageService } from "./storage.usecases.js";

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ cookie, userId } = await t.signIn());
});

describe("storage routes", () => {
  it("requires a session", async () => {
    expect((await t.app.request("/api/storage/drivers")).status).toBe(401);
  });

  it("lists each driver with its guide, readiness and document count", async () => {
    await t.services.documentsService.upload({ userId, name: "one.txt", mimeType: "text/plain", body: Readable.from(["a"]) });

    const res = await t.app.request("/api/storage/drivers", { headers: { cookie } });
    const body = (await res.json()) as { drivers: { id: string; label: string; configured: boolean; documentCount: number; active: boolean; guide: { steps: unknown[] } }[] };

    expect(res.status).toBe(200);
    const local = body.drivers.find((d) => d.id === "local")!;
    expect(local).toMatchObject({ label: "Local filesystem", configured: true, documentCount: 1, active: true });
    expect(local.guide.steps.length).toBeGreaterThan(0);
  });

  it("runs a driver's health check on demand", async () => {
    const res = await t.app.request("/api/storage/drivers/local/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects an unknown driver id before it reaches the registry", async () => {
    const res = await t.app.request("/api/storage/drivers/nope/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("includes the redirect uri and account email on an oauth driver's summary", async () => {
    const res = await t.app.request("/api/storage/drivers", { headers: { cookie } });
    const body = (await res.json()) as { drivers: { id: string; redirectUri?: string; accountEmail?: string }[] };
    const googleDrive = body.drivers.find((d) => d.id === "googleDrive")!;
    expect(googleDrive.redirectUri).toBe("http://localhost/api/storage/drivers/googleDrive/callback");
    expect(googleDrive.accountEmail).toBeUndefined();

    const local = body.drivers.find((d) => d.id === "local")!;
    expect(local.redirectUri).toBeUndefined();
  });
});

describe("storage oauth routes", () => {
  it("sends the browser to the provider with a signed state", async () => {
    await t.services.settingsService.set(userId, {
      "storage.googleDrive.clientId": "cid",
      "storage.googleDrive.clientSecret": "csecret",
    });

    const res = await t.app.request("/api/storage/drivers/googleDrive/connect", { headers: { cookie }, redirect: "manual" });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("state")).toMatch(/\./);
    // The secret never leaves the server.
    expect(res.headers.get("location")).not.toContain("csecret");
  });

  it("refuses to connect a driver that has no oauth hook", async () => {
    expect((await t.app.request("/api/storage/drivers/local/connect", { headers: { cookie } })).status).toBe(400);
  });

  it("refuses to connect before a client id is saved", async () => {
    expect((await t.app.request("/api/storage/drivers/googleDrive/connect", { headers: { cookie } })).status).toBe(400);
  });

  it("rejects a callback whose state was not issued by us", async () => {
    const res = await t.app.request("/api/storage/drivers/googleDrive/callback?code=abc&state=forged.signature");
    expect(res.status).toBe(400);
  });

  it("rejects a callback whose state names a different driver", async () => {
    const state = signOAuthState({ userId, driverId: "local", secretHex: t.config.settingsEncryptionKey });
    const res = await t.app.request(`/api/storage/drivers/googleDrive/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
  });

  it("stores the refresh token and the account on a good callback", async () => {
    // The state carries identity on its own, so this request sends no session cookie at
    // all, exactly like the redirect a browser makes back from Google.
    await t.services.settingsService.set(userId, {
      "storage.googleDrive.clientId": "cid",
      "storage.googleDrive.clientSecret": "csecret",
    });
    const exchange = vi.spyOn(googleDriveDriverDefinition.oauth!, "exchange").mockResolvedValue({
      refreshToken: "refresh-token-value",
      accountEmail: "someone@example.com",
    });

    try {
      const state = signOAuthState({ userId, driverId: "googleDrive", secretHex: t.config.settingsEncryptionKey });
      const res = await t.app.request(`/api/storage/drivers/googleDrive/callback?code=abc&state=${state}`, { redirect: "manual" });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).not.toContain("refresh-token-value");
      expect(await t.services.settingsService.get(userId, "storage.googleDrive.accountEmail")).toBe("someone@example.com");

      const rows = await t.services.settingsService.debugRows(userId);
      const refreshTokenRow = rows.find((r) => r.key === "storage.googleDrive.refreshToken");
      expect(refreshTokenRow?.isSecret).toBe(1);
    } finally {
      exchange.mockRestore();
    }
  });
});

describe("storage oauth callback dispatch", () => {
  const secretHex = "56".repeat(32);

  function makeDispatchApp(completers: Record<string, OAuthCallbackCompleter>) {
    const storageService = createStorageService({
      settingsService: { get: async () => undefined } as never,
      countDocuments: async () => 0,
    });
    const app = new Hono();
    app.onError(errorHandler);
    registerStorageRoutes({ app, storageService, getUserId: () => "unused", settingsEncryptionKey: secretHex, completers });
    return app;
  }

  it("reaches the injected completer for a non-storage purpose and redirects where it says", async () => {
    const completer: OAuthCallbackCompleter = vi.fn(async () => ({ redirectTo: "/settings?tab=email&connected=gmail" }));
    const app = makeDispatchApp({ "email:gmail": completer });
    const state = signState({ userId: "user_1", purpose: "email:gmail", secretHex });

    const res = await app.request(`/api/storage/drivers/googleDrive/callback?code=abc&state=${state}`, { redirect: "manual" });

    expect(completer).toHaveBeenCalledWith({ code: "abc", state, origin: "http://localhost" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings?tab=email&connected=gmail");
  });

  it("reaches the completer even when the unsigned path parameter names a different driver", async () => {
    const completer: OAuthCallbackCompleter = vi.fn(async () => ({ redirectTo: "/settings?tab=email&connected=gmail" }));
    const app = makeDispatchApp({ "email:gmail": completer });
    const state = signState({ userId: "user_1", purpose: "email:gmail", secretHex });

    const res = await app.request(`/api/storage/drivers/local/callback?code=abc&state=${state}`, { redirect: "manual" });

    expect(completer).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
  });

  it("rejects a purpose that is neither storage nor in the completer table, before calling anything", async () => {
    const app = makeDispatchApp({});
    const state = signState({ userId: "user_1", purpose: "calendar:google", secretHex });

    const res = await app.request(`/api/storage/drivers/googleDrive/callback?code=abc&state=${state}`);

    expect(res.status).toBe(400);
  });
});
