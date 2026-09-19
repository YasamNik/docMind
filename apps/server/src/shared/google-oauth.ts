import type { Credentials } from "google-auth-library";
import { OAuth2Client } from "google-auth-library";
import * as v from "valibot";
import { createError } from "./errors/errors.js";

// Google OAuth for any DocMind feature that borrows the app already registered for
// Google Drive, in the pattern google-drive.driver.ts established for its own consent
// flow: google-auth-library's OAuth2Client for the exchange and its own five minute
// eager refresh window for a cached access token. Kept as its own file rather than
// pulled out of the Drive driver, so Drive's working code is never touched. Nothing
// here knows about settings keys, drivers or mailboxes, and nothing here logs or
// returns a token or a secret.

const REAUTH_REASONS = new Set(["invalid_grant", "invalid_token", "unauthorized_client"]);

function isReauthRequired(error: unknown): boolean {
  const failure = error as { message?: string; response?: { data?: { error?: string } } } | undefined;
  const reason = failure?.response?.data?.error ?? failure?.message;
  return typeof reason === "string" && REAUTH_REASONS.has(reason);
}

// Every call into google-auth-library on this page is wrapped so only one of these two
// neutral, sanitized codes ever leaves this file, with no property of the underlying
// error, which can carry the request body and so the client secret or refresh token.
function sanitizedGoogleAuthError(error: unknown, message: string) {
  if (isReauthRequired(error)) {
    return createError({
      code: "google.reauth_required",
      message: "Google access has expired or been revoked. Reconnect the account and try again.",
      status: 401,
    });
  }
  return createError({ code: "google.auth_failed", message, status: 502 });
}

export function buildGoogleAuthorizeUrl(args: { clientId: string; redirectUri: string; scopes: string[]; state: string }): string {
  const client = new OAuth2Client({ clientId: args.clientId, redirectUri: args.redirectUri });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: args.scopes,
    state: args.state,
  });
}

export type GoogleCodeExchangeResult = { refreshToken: string; accessToken: string; idToken?: string };

export async function exchangeGoogleAuthCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleCodeExchangeResult> {
  const client = new OAuth2Client({ clientId: args.clientId, clientSecret: args.clientSecret, redirectUri: args.redirectUri });
  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken({ code: args.code, redirect_uri: args.redirectUri }));
  } catch (error) {
    throw sanitizedGoogleAuthError(error, "Google authentication failed while exchanging the authorization code.");
  }

  if (!tokens.refresh_token || !tokens.access_token) {
    throw createError({
      code: "google.auth_failed",
      message: "Google did not return a refresh token and an access token for this connection.",
      status: 400,
    });
  }

  return { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, idToken: tokens.id_token ?? undefined };
}

export type GoogleAccessTokenProvider = { getAccessToken(): Promise<string> };

// Holds one OAuth2Client per call, which is where the cached token and its expiry
// actually live: google-auth-library only refetches when the credentials it holds have
// no access token yet or are within its own five minute eager refresh window, so a
// caller that keeps this provider around for the life of a connection gets one token
// fetch per hour rather than one per cycle. Memoizing one provider per client id and
// refresh token identity, so clearing or replacing a connection drops the cache, is the
// caller's job, not this function's.
export function createGoogleAccessTokenProvider(args: { clientId: string; clientSecret: string; refreshToken: string }): GoogleAccessTokenProvider {
  const client = new OAuth2Client({ clientId: args.clientId, clientSecret: args.clientSecret });
  client.setCredentials({ refresh_token: args.refreshToken });

  return {
    async getAccessToken() {
      let token: string | null | undefined;
      try {
        ({ token } = await client.getAccessToken());
      } catch (error) {
        throw sanitizedGoogleAuthError(error, "Could not mint a Google access token.");
      }
      if (!token) {
        throw createError({ code: "google.auth_failed", message: "Google did not return an access token.", status: 502 });
      }
      return token;
    },
  };
}

const googleIdTokenPayloadSchema = v.object({
  email: v.pipe(v.string(), v.minLength(1)),
});

export type GoogleIdentity = { email: string };

// Verifies the id token's signature and audience before any claim in it is trusted, then
// parses only the one field this codebase needs. The raw token is never included in a
// thrown error: a bad signature or a malformed payload both become the same neutral
// code, carrying none of the token's own content.
export async function verifyGoogleIdToken(args: { idToken: string; clientId: string }): Promise<GoogleIdentity> {
  const client = new OAuth2Client({ clientId: args.clientId });
  let payload: unknown;
  try {
    const ticket = await client.verifyIdToken({ idToken: args.idToken, audience: args.clientId });
    payload = ticket.getPayload();
  } catch {
    throw createError({ code: "google.auth_failed", message: "Could not verify the Google account.", status: 400 });
  }

  const parsed = v.safeParse(googleIdTokenPayloadSchema, payload);
  if (!parsed.success) {
    throw createError({ code: "google.auth_failed", message: "Google did not return a usable account address.", status: 400 });
  }
  return { email: parsed.output.email };
}
