import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createSettingsRegistry, defineSetting } from "./settings.registry.js";
import { createSettingsService } from "./settings.usecases.js";

const keyHex = "ab".repeat(32);
const user = "user-1";

const definitions = [
  defineSetting({ key: "test.color", schema: v.string(), env: "TEST_COLOR", default: "blue", doc: "A color" }),
  defineSetting({ key: "test.apiKey", schema: v.string(), env: "TEST_API_KEY", secret: true, doc: "A key" }),
  defineSetting({ key: "test.limit", schema: v.number(), default: 25, doc: "A number" }),
];

function service(env: Record<string, string | undefined> = {}) {
  return createTestDatabase().then(({ db }) =>
    createSettingsService({
      db,
      registry: createSettingsRegistry(definitions),
      config: { settingsEncryptionKey: keyHex, env },
    }),
  );
}

describe("settings service", () => {
  it("resolves default, then env, then db", async () => {
    const s = await service({ TEST_COLOR: "green" });
    expect(await s.getResolved(user, "test.limit")).toMatchObject({ value: 25, source: "default" });
    expect(await s.getResolved(user, "test.color")).toMatchObject({ value: "green", source: "env" });
    await s.set(user, { "test.color": "red" });
    expect(await s.getResolved(user, "test.color")).toMatchObject({ value: "red", source: "db" });
  });

  it("stores secrets encrypted and masks them on read", async () => {
    const s = await service();
    await s.set(user, { "test.apiKey": "sk-or-v1-1234567890" });
    const rows = await s.debugRows(user);
    expect(rows[0]?.value.startsWith("enc:v1:")).toBe(true);
    expect(await s.get(user, "test.apiKey")).toBe("sk-or-v1-1234567890");
    expect(await s.getResolved(user, "test.apiKey")).toMatchObject({
      value: { isSet: true, lastFour: "7890" },
      source: "db",
      secret: true,
    });
  });

  it("reports an unset secret without leaking anything", async () => {
    const s = await service();
    expect(await s.getResolved(user, "test.apiKey")).toMatchObject({ value: { isSet: false }, source: "unset" });
  });

  it("null deletes the row so the value falls back", async () => {
    const s = await service({ TEST_COLOR: "green" });
    await s.set(user, { "test.color": "red" });
    await s.set(user, { "test.color": null });
    expect(await s.getResolved(user, "test.color")).toMatchObject({ value: "green", source: "env" });
  });

  it("empty string on a secret deletes the row", async () => {
    const s = await service();
    await s.set(user, { "test.apiKey": "abc" });
    await s.set(user, { "test.apiKey": "" });
    expect(await s.getResolved(user, "test.apiKey")).toMatchObject({ value: { isSet: false } });
  });

  it("rejects values that fail the schema and unknown keys", async () => {
    const s = await service();
    await expectAppError(() => s.set(user, { "test.limit": "not a number" }), "settings.invalid_value");
    await expectAppError(() => s.set(user, { "nope": 1 }), "settings.unknown_key");
  });

  it("keeps a multi-key set() atomic when one key is unknown", async () => {
    const s = await service({ TEST_COLOR: "green" });
    const before = await s.getResolved(user, "test.color");
    await expectAppError(() => s.set(user, { "test.color": "red", "nope": 1 }), "settings.unknown_key");
    expect(await s.getResolved(user, "test.color")).toEqual(before);
    const rows = await s.debugRows(user);
    expect(rows.some((r) => r.key === "test.color")).toBe(false);
  });

  it("does not leak lastFour for a short secret", async () => {
    const s = await service();
    await s.set(user, { "test.apiKey": "abcde" });
    const { value } = await s.getResolved(user, "test.apiKey");
    expect(value).toEqual({ isSet: true });
  });

  it("serves from cache and invalidates on write", async () => {
    const s = await service();
    await s.set(user, { "test.limit": 5 });
    expect(await s.get(user, "test.limit")).toBe(5);
    await s.set(user, { "test.limit": 6 });
    expect(await s.get(user, "test.limit")).toBe(6);
  });
});
