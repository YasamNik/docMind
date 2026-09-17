import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { count } from "drizzle-orm";
import type { Database } from "../database/database.js";
import * as authTables from "./auth.tables.js";

export type AuthConfig = { authSecret: string; serverBaseUrl: string; clientBaseUrl: string };

export function createAuth({ db, config }: { db: Database; config: AuthConfig }) {
  return betterAuth({
    secret: config.authSecret,
    baseURL: config.serverBaseUrl,
    basePath: "/api/auth",
    trustedOrigins: [config.clientBaseUrl, config.serverBaseUrl, "https://*.trycloudflare.com"],
    database: drizzleAdapter(db, { provider: "sqlite", schema: authTables }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 9,
      sendResetPassword: async ({ user, url }) => {
        console.log(`\n[DocMind] Password reset link for ${user.email}:\n${url}\n`);
      },
    },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            const [row] = await db.select({ n: count() }).from(authTables.user);
            if ((row?.n ?? 0) > 0) {
              throw new APIError("BAD_REQUEST", { message: "Sign up is closed. This DocMind already has its user." });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
