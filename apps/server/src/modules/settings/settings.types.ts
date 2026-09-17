import type { GenericSchema } from "valibot";

export type SettingDefinition<T = unknown> = {
  key: string;
  schema: GenericSchema<unknown, T>;
  env?: string;
  default?: T;
  secret: boolean;
  // Internal settings are written by other server modules only. They never appear in
  // GET /api/settings and PUT /api/settings rejects writes to them.
  internal?: boolean;
  doc: string;
};

export type SettingSource = "db" | "env" | "default" | "unset";

export type MaskedSecret = { isSet: boolean; lastFour?: string };

export type ResolvedSetting = {
  key: string;
  value: unknown;
  source: SettingSource;
  secret: boolean;
  doc: string;
};
