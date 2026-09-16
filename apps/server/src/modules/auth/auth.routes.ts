import type { Hono } from "hono";
import { count } from "drizzle-orm";
import type { Database } from "../database/database.js";
import type { Auth } from "./auth.services.js";
import { user as userTable } from "./auth.tables.js";

export function registerAuthRoutes({ app, auth, db }: { app: Hono; auth: Auth; db: Database }) {
  app.get("/api/auth/status", async (c) => {
    const [row] = await db.select({ n: count() }).from(userTable);
    return c.json({ hasUsers: (row?.n ?? 0) > 0 });
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}
