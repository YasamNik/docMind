import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ cookie, userId } = await t.signIn());
});

describe("telegram routes", () => {
  it("requires a session", async () => {
    expect((await t.app.request("/api/telegram/status")).status).toBe(401);
  });

  it("reports no token, no pairing, and no code before anything is configured", async () => {
    const res = await t.app.request("/api/telegram/status", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokenSet: false, paired: false });
  });

  it("shows a pairing code once a token is set, with no pairing yet", async () => {
    await t.services.settingsService.set(userId, { "telegram.botToken": "111:token" });

    const res = await t.app.request("/api/telegram/status", { headers: { cookie } });
    const body = (await res.json()) as { tokenSet: boolean; paired: boolean; pairingCode?: string };

    expect(body.tokenSet).toBe(true);
    expect(body.paired).toBe(false);
    expect(body.pairingCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("issues a pairing code only when a token exists", async () => {
    const withoutToken = await t.app.request("/api/telegram/pairing-code", { method: "POST", headers: { cookie } });
    expect(withoutToken.status).toBe(400);

    await t.services.settingsService.set(userId, { "telegram.botToken": "111:token" });
    const withToken = await t.app.request("/api/telegram/pairing-code", { method: "POST", headers: { cookie } });

    expect(withToken.status).toBe(200);
    const body = (await withToken.json()) as { pairingCode: string };
    expect(body.pairingCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("issuing a new pairing code replaces the one shown on status", async () => {
    await t.services.settingsService.set(userId, { "telegram.botToken": "111:token" });
    const first = (await (await t.app.request("/api/telegram/status", { headers: { cookie } })).json()) as { pairingCode: string };

    const reissued = (await (
      await t.app.request("/api/telegram/pairing-code", { method: "POST", headers: { cookie } })
    ).json()) as { pairingCode: string };

    expect(reissued.pairingCode).not.toBe(first.pairingCode);
    const after = (await (await t.app.request("/api/telegram/status", { headers: { cookie } })).json()) as { pairingCode: string };
    expect(after.pairingCode).toBe(reissued.pairingCode);
  });

  it("never returns the bot token itself", async () => {
    await t.services.settingsService.set(userId, { "telegram.botToken": "111:secret-token-value" });

    const statusText = await (await t.app.request("/api/telegram/status", { headers: { cookie } })).text();
    const pairingText = await (
      await t.app.request("/api/telegram/pairing-code", { method: "POST", headers: { cookie } })
    ).text();

    expect(statusText).not.toContain("111:secret-token-value");
    expect(statusText).not.toContain("secret-token-value");
    expect(pairingText).not.toContain("111:secret-token-value");
    expect(pairingText).not.toContain("secret-token-value");
  });

  it("shows who it is paired with once paired", async () => {
    await t.services.settingsService.set(userId, { "telegram.botToken": "111:token" });
    await t.services.settingsService.setInternal(userId, "telegram.pairedUserId", 42);
    await t.services.settingsService.setInternal(userId, "telegram.pairedName", "Yasam");

    const res = await t.app.request("/api/telegram/status", { headers: { cookie } });

    expect(await res.json()).toEqual({ tokenSet: true, paired: true, pairedName: "Yasam" });
  });

  it("unpairs and issues a fresh code", async () => {
    await t.services.settingsService.set(userId, { "telegram.botToken": "111:token" });
    await t.services.settingsService.setInternal(userId, "telegram.pairedUserId", 42);
    await t.services.settingsService.setInternal(userId, "telegram.pairedName", "Yasam");

    const res = await t.app.request("/api/telegram/unpair", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const status = (await (await t.app.request("/api/telegram/status", { headers: { cookie } })).json()) as {
      tokenSet: boolean;
      paired: boolean;
      pairingCode?: string;
      pairedName?: string;
    };
    expect(status).toEqual({ tokenSet: true, paired: false, pairingCode: expect.stringMatching(/^[A-Z0-9]{6}$/) });
  });
});
