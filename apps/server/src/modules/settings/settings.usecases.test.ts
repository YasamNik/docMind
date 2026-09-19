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
  defineSetting({ key: "test.internalDimension", schema: v.number(), internal: true, default: 0, doc: "Internal only" }),
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

  it("excludes internal settings from listResolved", async () => {
    const s = await service();
    const keys = (await s.listResolved(user)).map((r) => r.key);
    expect(keys).not.toContain("test.internalDimension");
    expect(keys).toContain("test.color");
  });

  it("rejects a public set() write to an internal key", async () => {
    const s = await service();
    await expectAppError(() => s.set(user, { "test.internalDimension": 1536 }), "settings.internal_only");
  });

  it("keeps other keys unwritten when a set() call touches an internal key", async () => {
    const s = await service();
    await expectAppError(
      () => s.set(user, { "test.color": "red", "test.internalDimension": 1536 }),
      "settings.internal_only",
    );
    expect(await s.get(user, "test.color")).toBe("blue");
  });

  it("setInternal writes and reads back an internal setting", async () => {
    const s = await service();
    await s.setInternal(user, "test.internalDimension", 1536);
    expect(await s.get(user, "test.internalDimension")).toBe(1536);
    expect(await s.getResolved(user, "test.internalDimension")).toMatchObject({ value: 1536, source: "db" });
  });

  it("setInternal throws when called on a non-internal setting", async () => {
    const s = await service();
    await expect(s.setInternal(user, "test.color", "red")).rejects.toThrow(
      /setInternal called on non-internal setting/,
    );
  });

  it("removeInternal deletes an internal setting so it falls back to its default", async () => {
    const s = await service();
    await s.setInternal(user, "test.internalDimension", 1536);
    await s.removeInternal(user, "test.internalDimension");
    expect(await s.get(user, "test.internalDimension")).toBe(0);
  });

  it("removeInternal throws when called on a non-internal setting", async () => {
    const s = await service();
    await expect(s.removeInternal(user, "test.color")).rejects.toThrow(
      /removeInternal called on non-internal setting/,
    );
  });
});
