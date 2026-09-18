import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import * as v from "valibot";
import { createError } from "../../shared/errors/errors.js";

// The OAuth callback is a browser redirect from the provider, not an app request, so it
// carries no session cookie. This state is the only thing that says which user the
// incoming code belongs to, which is why it has to be signed rather than just opaque.
const STATE_TTL_MS = 10 * 60 * 1000;
const HKDF_LABEL = "oauth-state";
const HKDF_KEY_LENGTH = 32;

const oauthStatePayloadSchema = v.object({
  userId: v.string(),
  driverId: v.string(),
  issuedAt: v.string(),
});

function invalidStateError() {
  return createError({
    code: "storage.invalid_state",
    message: "Invalid oauth state",
    status: 400,
  });
}

function expiredStateError() {
  return createError({
    code: "storage.invalid_state",
    message: "Oauth state expired",
    status: 400,
  });
}

function deriveSigningKey(secretHex: string) {
  const ikm = Buffer.from(secretHex, "hex");
  const derived = hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(HKDF_LABEL), HKDF_KEY_LENGTH);
  return Buffer.from(derived);
}

function sign(payloadBase64Url: string, secretHex: string) {
  const key = deriveSigningKey(secretHex);
  return createHmac("sha256", key).update(payloadBase64Url).digest("base64url");
}

export function signOAuthState(args: { userId: string; driverId: string; secretHex: string; now?: Date }) {
  const issuedAt = (args.now ?? new Date()).toISOString();
  const payload = { userId: args.userId, driverId: args.driverId, issuedAt };
  const payloadBase64Url = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(payloadBase64Url, args.secretHex);
  return `${payloadBase64Url}.${signature}`;
}

export function verifyOAuthState(args: { state: string; secretHex: string; now?: Date }) {
  const parts = args.state.split(".");
  if (parts.length !== 2) throw invalidStateError();
  const [payloadBase64Url, signature] = parts as [string, string];

  const expectedSignature = sign(payloadBase64Url, args.secretHex);
  const provided = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw invalidStateError();
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(Buffer.from(payloadBase64Url, "base64url").toString("utf8"));
  } catch {
    throw invalidStateError();
  }

  const parsed = v.safeParse(oauthStatePayloadSchema, rawPayload);
  if (!parsed.success) throw invalidStateError();

  const issuedAtMs = new Date(parsed.output.issuedAt).getTime();
  if (Number.isNaN(issuedAtMs)) throw invalidStateError();

  const nowMs = (args.now ?? new Date()).getTime();
  if (nowMs - issuedAtMs > STATE_TTL_MS) throw expiredStateError();

  return { userId: parsed.output.userId, driverId: parsed.output.driverId };
}
