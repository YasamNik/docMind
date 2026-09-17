import type { GenericSchema } from "valibot";
import { createError } from "../../shared/errors/errors.js";
import type { SettingDefinition } from "./settings.types.js";

export function defineSetting<T>(args: {
  key: string;
  schema: GenericSchema<unknown, T>;
  env?: string;
  default?: T;
  secret?: boolean;
  internal?: boolean;
  doc: string;
}): SettingDefinition<T> {
  return { secret: false, internal: args.internal ?? false, ...args };
}

export function createSettingsRegistry(definitions: SettingDefinition[]) {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  if (byKey.size !== definitions.length) throw new Error("Duplicate setting key in registry");
  return {
    get(key: string): SettingDefinition {
      const definition = byKey.get(key);
      if (!definition) {
        throw createError({ code: "settings.unknown_key", message: `Unknown setting "${key}"`, status: 400 });
      }
      return definition;
    },
    has(key: string) {
      return byKey.has(key);
    },
    all(): SettingDefinition[] {
      return [...byKey.values()];
    },
  };
}

export type SettingsRegistry = ReturnType<typeof createSettingsRegistry>;
