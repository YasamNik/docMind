import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { requireUser, sessionMiddleware } from "./auth.middleware.js";
import { registerAuthRoutes } from "./auth.routes.js";
import { createAuth } from "./auth.services.js";

const config = { authSecret: "s".repeat(32), serverBaseUrl: "http://localhost:4000", clientBaseUrl: "http://localhost:5173" };

async function makeApp() {
  const { db } = await createTestDatabase();
  const auth = createAuth({ db, config });
  const app = new Hono();
  app.onError(errorHandler);
  registerAuthRoutes({ app, auth, db });
  app.get("/api/whoami", sessionMiddleware(auth), (c) => c.json({ email: requireUser(c).email }));
  return { app, auth };
}

async function signUp(app: Hono, email: string) {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.clientBaseUrl },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Yasam" }),
  });
}

describe("auth", () => {
  it("reports whether users exist", async () => {
    const { app } = await makeApp();
    expect(await (await app.request("/api/auth/status")).json()).toEqual({ hasUsers: false });
    expect((await signUp(app, "first@example.com")).status).toBe(200);
    expect(await (await app.request("/api/auth/status")).json()).toEqual({ hasUsers: true });
  });

  it("allows only the first sign up", async () => {
    const { app } = await makeApp();
    expect((await signUp(app, "first@example.com")).status).toBe(200);
    const second = await signUp(app, "second@example.com");
    expect(second.status).toBe(400);
  });

  it("protects routes and identifies the signed in user", async () => {
    const { app } = await makeApp();
    expect((await app.request("/api/whoami")).status).toBe(401);
    const res = await signUp(app, "first@example.com");
    const cookie = res.headers.get("set-cookie") ?? "";
    const who = await app.request("/api/whoami", { headers: { cookie } });
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ email: "first@example.com" });
  });
});
