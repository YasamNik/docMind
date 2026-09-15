import * as v from "valibot";
import { hexKeySchema, portSchema, requiredMessage, urlSchema } from "./config.schemas.js";

const envSchema = v.pipe(
  v.object({
    PORT: portSchema,
    SERVER_BASE_URL: v.optional(urlSchema, "http://localhost:4000"),
    CLIENT_BASE_URL: v.optional(urlSchema, "http://localhost:5173"),
    AUTH_SECRET: v.optional(v.pipe(v.string(), v.minLength(32))),
    DATABASE_URL: v.optional(v.string(), "file:./docmind.sqlite"),
    SETTINGS_ENCRYPTION_KEY: v.optional(hexKeySchema(32, "SETTINGS_ENCRYPTION_KEY")),
  }),
  v.check(
    (o) => o.AUTH_SECRET !== undefined,
    requiredMessage("AUTH_SECRET", 48),
  ),
  v.check(
    (o) => o.SETTINGS_ENCRYPTION_KEY !== undefined,
    requiredMessage("SETTINGS_ENCRYPTION_KEY", 32),
  ),
);

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

  return {
    port: e.PORT,
    serverBaseUrl: e.SERVER_BASE_URL,
    clientBaseUrl: e.CLIENT_BASE_URL,
    authSecret: e.AUTH_SECRET as string,
    databaseUrl: e.DATABASE_URL,
    settingsEncryptionKey: e.SETTINGS_ENCRYPTION_KEY as string,
    env,
  };
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
