import * as v from "valibot";
import { hexKeySchema, portSchema, urlSchema } from "./config.schemas.js";

const envSchema = v.object({
  PORT: portSchema,
  SERVER_BASE_URL: v.optional(urlSchema, "http://localhost:4000"),
  CLIENT_BASE_URL: v.optional(urlSchema, "http://localhost:5173"),
  AUTH_SECRET: v.pipe(v.string("AUTH_SECRET is required. Generate one with: openssl rand -hex 48"), v.minLength(32)),
  DATABASE_URL: v.optional(v.string(), "file:./docmind.sqlite"),
  SETTINGS_ENCRYPTION_KEY: v.optional(hexKeySchema(32, "SETTINGS_ENCRYPTION_KEY")),
});

export type Config = {
  port: number;
  serverBaseUrl: string;
  clientBaseUrl: string;
  authSecret: string;
  databaseUrl: string;
  settingsEncryptionKey: string;
  env: Record<string, string | undefined>;
};

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = v.safeParse(envSchema, env);
  if (!result.success) {
    const lines = result.issues.map((issue) => {
      const key = issue.path?.map((p) => String(p.key)).join(".") ?? "env";
      return `${key}: ${issue.message}`;
    });
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = result.output;

  if (!e.SETTINGS_ENCRYPTION_KEY) {
    throw new Error(`Invalid configuration:\nSETTINGS_ENCRYPTION_KEY: SETTINGS_ENCRYPTION_KEY is required. Generate one with: openssl rand -hex 32`);
  }

  return {
    port: e.PORT,
    serverBaseUrl: e.SERVER_BASE_URL,
    clientBaseUrl: e.CLIENT_BASE_URL,
    authSecret: e.AUTH_SECRET,
    databaseUrl: e.DATABASE_URL,
    settingsEncryptionKey: e.SETTINGS_ENCRYPTION_KEY,
    env,
  };
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
