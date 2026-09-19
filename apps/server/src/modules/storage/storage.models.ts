import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import * as v from "valibot";
import { createError } from "../../shared/errors/errors.js";

// The OAuth callback is a browser redirect from the provider, not an app request, so it
// carries no session cookie. This state is the only thing that says which user the
// incoming code belongs to, which is why it has to be signed rather than just opaque.
const STATE_TTL_MS = 10 * 60 * 1000;
const HKDF_LABEL = "oauth-state";
const HKDF_KEY_LENGTH = 32;

// storage: for a driver connection, email:gmail for a mailbox connection. Any module
// that needs a signed, short lived callback state can add its own prefix here without
// storage knowing anything about it: the payload only ever carries an opaque string.
// Exported so the callback route can recognize a storage purpose without hardcoding
// the prefix a second time.
export const STORAGE_PURPOSE_PREFIX = "storage:";

const oauthStatePayloadSchema = v.object({
  userId: v.string(),
  purpose: v.string(),
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

// The one signer for a callback state, whatever module it is for. `purpose` says what
// the state is for and is opaque to this function: it is only ever compared, never
// interpreted here.
export function signState(args: { userId: string; purpose: string; secretHex: string; now?: Date }) {
  const issuedAt = (args.now ?? new Date()).toISOString();
  const payload = { userId: args.userId, purpose: args.purpose, issuedAt };
  const payloadBase64Url = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(payloadBase64Url, args.secretHex);
  return `${payloadBase64Url}.${signature}`;
}

// The one verifier for a callback state. Signature and expiry are checked before the
// payload is trusted for anything else, since the callback that carries this state
// arrives with no session of its own.
export function verifyState(args: { state: string; secretHex: string; now?: Date }): { userId: string; purpose: string } {
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

  return { userId: parsed.output.userId, purpose: parsed.output.purpose };
}

// The redirect URI Google (or any future OAuth provider) sends the browser back to. It
// has to be built from the request that is actually serving the app, since a hardcoded
// value would break the moment the app is reached through a different host.
export function buildOAuthRedirectUri(args: { origin: string; driverId: string }) {
  return `${args.origin}/api/storage/drivers/${args.driverId}/callback`;
}

// Thin wrappers kept for every existing storage caller and test: a driver id in, a
// driver id out, storage:<driverId> as the purpose in between.
export function signOAuthState(args: { userId: string; driverId: string; secretHex: string; now?: Date }) {
  return signState({ userId: args.userId, purpose: `${STORAGE_PURPOSE_PREFIX}${args.driverId}`, secretHex: args.secretHex, now: args.now });
}

export function verifyOAuthState(args: { state: string; secretHex: string; now?: Date }): { userId: string; driverId: string } {
  const verified = verifyState(args);
  if (!verified.purpose.startsWith(STORAGE_PURPOSE_PREFIX)) throw invalidStateError();
  return { userId: verified.userId, driverId: verified.purpose.slice(STORAGE_PURPOSE_PREFIX.length) };
}
