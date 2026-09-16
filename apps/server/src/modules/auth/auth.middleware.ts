import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createError } from "../../shared/errors/errors.js";
import type { Auth } from "./auth.services.js";

export type SessionUser = { id: string; email: string; name: string };

export function sessionMiddleware(auth: Auth) {
  return createMiddleware(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null);
    await next();
  });
}

export function requireUser(c: Context): SessionUser {
  const user = c.get("user") as SessionUser | null | undefined;
  if (!user) throw createError({ code: "auth.unauthenticated", message: "Sign in required", status: 401 });
  return user;
}
