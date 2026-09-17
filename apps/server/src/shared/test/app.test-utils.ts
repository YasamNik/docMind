import { parseConfig } from "../../modules/config/config.js";
import type { OcrEngine } from "../../modules/extraction/ocr.js";
import { createServer } from "../../server.js";
import { createTestDatabase } from "./database.test-utils.js";

const fakeOcrEngine: OcrEngine = {
  recognize: async () => ({ text: "OCR TEXT", confidence: 95 }),
  terminate: async () => {},
};

export async function createTestApp({
  env = {},
  ocrEngine = fakeOcrEngine,
  adapterFactories,
}: { env?: Record<string, string>; ocrEngine?: OcrEngine; adapterFactories?: Parameters<typeof createServer>[0]["adapterFactories"] } = {}) {
  const config = parseConfig({
    SETTINGS_ENCRYPTION_KEY: "11".repeat(32),
    AUTH_SECRET: "t".repeat(32),
    DATABASE_URL: ":memory:",
    ...env,
  });
  const { db } = await createTestDatabase();
  const server = createServer({ config, db, ocrEngine, adapterFactories });

  async function signIn(email = "owner@example.com") {
    const res = await server.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.clientBaseUrl },
      body: JSON.stringify({ email, password: "correct horse battery", name: "Owner" }),
    });
    if (res.status !== 200) throw new Error(`sign up failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { user: { id: string } };
    return { cookie: res.headers.get("set-cookie") ?? "", userId: body.user.id };
  }

  return { app: server.app, db, services: server, config, signIn };
}
