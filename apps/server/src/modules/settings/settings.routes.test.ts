import { Hono } from "hono";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry, defineSetting } from "./settings.registry.js";
import { registerSettingsRoutes } from "./settings.routes.js";
import { createSettingsService } from "./settings.usecases.js";

async function makeApp() {
  const { db } = await createTestDatabase();
  const registry = createSettingsRegistry([
    defineSetting({ key: "test.color", schema: v.string(), default: "blue", doc: "A color" }),
    defineSetting({ key: "test.apiKey", schema: v.string(), secret: true, doc: "A key" }),
  ]);
  const settingsService = createSettingsService({ db, registry, config: { settingsEncryptionKey: "cd".repeat(32), env: {} } });
  const app = new Hono();
  app.onError(errorHandler);
  registerSettingsRoutes({ app, settingsService, getUserId: () => "user-1" });
  return app;
}

describe("settings routes", () => {
  it("lists settings with masked secrets", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "test.color", value: "blue", source: "default" }),
        expect.objectContaining({ key: "test.apiKey", value: { isSet: false }, secret: true }),
      ]),
    );
  });

  it("updates values and never echoes a secret", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { "test.color": "red", "test.apiKey": "sk-or-v1-1234" } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-or-v1-1234");
    const body = JSON.parse(text);
    expect(body.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "test.color", value: "red", source: "db" }),
        expect.objectContaining({ key: "test.apiKey", value: { isSet: true, lastFour: "1234" } }),
      ]),
    );
  });

  it("returns 400 with a code for a bad key", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { nope: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "settings.unknown_key" } });
  });

  it("returns 400 for a malformed body", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation" } });
  });
});
