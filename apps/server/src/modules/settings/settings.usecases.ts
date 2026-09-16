import * as v from "valibot";
import type { Database } from "../database/database.js";
import { createError } from "../../shared/errors/errors.js";
import { decryptSecret, encryptSecret } from "./settings.crypto.js";
import { createSettingsRepository } from "./settings.repository.js";
import type { SettingsRegistry } from "./settings.registry.js";
import type { MaskedSecret, ResolvedSetting, SettingDefinition } from "./settings.types.js";

type ServiceConfig = { settingsEncryptionKey: string; env: Record<string, string | undefined> };

function mask(plaintext: string | undefined): MaskedSecret {
  if (!plaintext) return { isSet: false };
  if (plaintext.length < 8) return { isSet: true };
  return { isSet: true, lastFour: plaintext.slice(-4) };
}

export function createSettingsService({
  db,
  registry,
  config,
}: {
  db: Database;
  registry: SettingsRegistry;
  config: ServiceConfig;
}) {
  const repository = createSettingsRepository({ db });
  // userId -> key -> raw db value (ciphertext for secrets, JSON otherwise)
  const cache = new Map<string, Map<string, string>>();

  async function rowsFor(userId: string) {
    let rows = cache.get(userId);
    if (!rows) {
      const stored = await repository.listForUser(userId);
      rows = new Map(stored.map((r) => [r.key, r.value]));
      cache.set(userId, rows);
    }
    return rows;
  }

  function parseOrThrow(definition: SettingDefinition, value: unknown) {
    const result = v.safeParse(definition.schema, value);
    if (!result.success) {
      throw createError({
        code: "settings.invalid_value",
        message: `Invalid value for "${definition.key}": ${result.issues[0]?.message ?? "invalid"}`,
        status: 400,
      });
    }
    return result.output;
  }

  async function resolveRaw(userId: string, key: string): Promise<{ value: unknown; source: ResolvedSetting["source"] }> {
    const definition = registry.get(key);
    const rows = await rowsFor(userId);
    const stored = rows.get(key);
    if (stored !== undefined) {
      if (definition.secret) return { value: decryptSecret({ ciphertext: stored, keyHex: config.settingsEncryptionKey }), source: "db" };
      return { value: parseOrThrow(definition, JSON.parse(stored)), source: "db" };
    }
    const fromEnv = definition.env ? config.env[definition.env] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") {
      return { value: definition.secret ? fromEnv : parseOrThrow(definition, coerceEnv(definition, fromEnv)), source: "env" };
    }
    if (definition.default !== undefined) return { value: definition.default, source: "default" };
    return { value: undefined, source: "unset" };
  }

  function coerceEnv(definition: SettingDefinition, raw: string): unknown {
    // Env vars are strings. Try JSON first so numbers and booleans work, fall back to the string.
    try {
      const parsed = JSON.parse(raw);
      return v.safeParse(definition.schema, parsed).success ? parsed : raw;
    } catch {
      return raw;
    }
  }

  async function getResolvedFor(userId: string, key: string): Promise<ResolvedSetting> {
    const definition = registry.get(key);
    const { value, source } = await resolveRaw(userId, key);
    return {
      key,
      value: definition.secret ? mask(value as string | undefined) : value,
      source,
      secret: definition.secret,
      doc: definition.doc,
    };
  }

  return {
    async get<T = unknown>(userId: string, key: string): Promise<T | undefined> {
      return (await resolveRaw(userId, key)).value as T | undefined;
    },

    async getResolved(userId: string, key: string): Promise<ResolvedSetting> {
      return getResolvedFor(userId, key);
    },

    async listResolved(userId: string): Promise<ResolvedSetting[]> {
      return Promise.all(registry.all().map((d) => getResolvedFor(userId, d.key)));
    },

    async set(userId: string, updates: Record<string, unknown>) {
      // Two-phase: resolve every write first (throwing on any unknown key or invalid
      // value before touching the database), then apply them. This keeps a multi-key
      // set() atomic: a failure on a later key never leaves an earlier key written
      // with a now-stale cache.
      const writes: Array<
        | { type: "remove"; key: string }
        | { type: "upsert"; key: string; value: string; isSecret: boolean }
      > = [];

      for (const [key, value] of Object.entries(updates)) {
        const definition = registry.get(key);
        const clears = value === null || (definition.secret && value === "");
        if (clears) {
          writes.push({ type: "remove", key });
          continue;
        }
        if (definition.secret) {
          const parsed = parseOrThrow(definition, value);
          if (typeof parsed !== "string") {
            throw createError({ code: "settings.invalid_value", message: `Secret "${key}" must be a string`, status: 400 });
          }
          writes.push({
            type: "upsert",
            key,
            isSecret: true,
            value: encryptSecret({ plaintext: parsed, keyHex: config.settingsEncryptionKey }),
          });
          continue;
        }
        const parsed = parseOrThrow(definition, value);
        writes.push({ type: "upsert", key, isSecret: false, value: JSON.stringify(parsed) });
      }

      for (const write of writes) {
        if (write.type === "remove") {
          await repository.remove({ userId, key: write.key });
        } else {
          await repository.upsert({ userId, key: write.key, isSecret: write.isSecret, value: write.value });
        }
      }

      cache.delete(userId);
    },

    invalidate() {
      cache.clear();
    },

    // Test helper. Returns raw rows so tests can assert ciphertext without reading the table directly.
    async debugRows(userId: string) {
      return repository.listForUser(userId);
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
