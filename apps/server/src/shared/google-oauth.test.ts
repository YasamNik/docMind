import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectAppError } from "./test/errors.test-utils.js";
import {
  buildGoogleAuthorizeUrl,
  createGoogleAccessTokenProvider,
  exchangeGoogleAuthCode,
  verifyGoogleIdToken,
} from "./google-oauth.js";

// A fake GaxiosError shaped the way google-auth-library actually throws one, the same
// shape the Google Drive driver's own tests use: the provider's error code lives on the
// response body, and whatever the library sent along, secrets included, lives on the
// request config. None of that may reach an AppError this file throws.
function fakeInvalidGrantError() {
  return Object.assign(new Error("invalid_grant"), {
    response: { data: { error: "invalid_grant" } },
    config: { data: new URLSearchParams({ client_secret: "leaked-client-secret", refresh_token: "leaked-refresh-token" }) },
  });
}

describe("buildGoogleAuthorizeUrl", () => {
  it("builds a consent url carrying the given scopes and no secret", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: "client-id",
        redirectUri: "https://example.com/api/storage/drivers/googleDrive/callback",
        scopes: ["https://mail.google.com/", "openid", "https://www.googleapis.com/auth/userinfo.email"],
        state: "abc.def",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("abc.def");
  });
});

describe("exchangeGoogleAuthCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the refresh token, access token and id token from a good exchange", async () => {
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({
      tokens: { refresh_token: "refresh-token", access_token: "access-token", id_token: "id-token" },
      res: undefined,
    } as never);

    const result = await exchangeGoogleAuthCode({
      code: "auth-code",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.com/callback",
    });

    expect(result).toEqual({ refreshToken: "refresh-token", accessToken: "access-token", idToken: "id-token" });
  });

  it("turns a revoked or expired grant into google.reauth_required, with no secret in it", async () => {
    vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(fakeInvalidGrantError());

    let caught: unknown;
    try {
      await exchangeGoogleAuthCode({ code: "bad-code", clientId: "client-id", clientSecret: "leaked-client-secret", redirectUri: "https://example.com/callback" });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("google.reauth_required");
    expect(JSON.stringify(caught)).not.toContain("leaked-client-secret");
    expect(JSON.stringify(caught)).not.toContain("leaked-refresh-token");
  });

  it("turns an unrelated exchange failure into google.auth_failed rather than the raw error", async () => {
    vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(new Error("fetch failed"));

    await expectAppError(
      () => exchangeGoogleAuthCode({ code: "code", clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://example.com/callback" }),
      "google.auth_failed",
    );
  });

  it("refuses a response missing a refresh token or an access token", async () => {
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { access_token: "access-token" }, res: undefined } as never);

    await expectAppError(
      () => exchangeGoogleAuthCode({ code: "code", clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://example.com/callback" }),
      "google.auth_failed",
    );
  });
});

describe("createGoogleAccessTokenProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mints a token once and reuses it for a call inside the cache window, then mints again after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    let calls = 0;
    vi.spyOn(OAuth2Client.prototype, "refreshAccessTokenAsync").mockImplementation(async function (this: OAuth2Client) {
      calls += 1;
      const credentials = { access_token: `token-${calls}`, expiry_date: Date.now() + 60 * 60 * 1000, refresh_token: this.credentials.refresh_token };
      this.credentials = credentials;
      return { credentials, res: null as never };
    });

    const provider = createGoogleAccessTokenProvider({ clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" });

    expect(await provider.getAccessToken()).toBe("token-1");
    expect(await provider.getAccessToken()).toBe("token-1");
    expect(calls).toBe(1);

    // 56 minutes later: inside the five minute window before the one hour token expires.
    vi.setSystemTime(new Date("2026-09-19T12:56:00.000Z"));
    expect(await provider.getAccessToken()).toBe("token-2");
    expect(calls).toBe(2);
  });

  it("turns a revoked refresh token into google.reauth_required", async () => {
    vi.spyOn(OAuth2Client.prototype, "refreshAccessTokenAsync").mockRejectedValue(fakeInvalidGrantError());

    const provider = createGoogleAccessTokenProvider({ clientId: "client-id", clientSecret: "client-secret", refreshToken: "revoked-refresh-token" });

    await expectAppError(() => provider.getAccessToken(), "google.reauth_required");
  });
});

describe("verifyGoogleIdToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the address out of a verified id token's payload", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({ email: "someone@example.com", email_verified: true }),
    } as never);

    const result = await verifyGoogleIdToken({ idToken: "id-token", clientId: "client-id" });

    expect(result).toEqual({ email: "someone@example.com" });
  });

  it("rejects a payload with no email, without echoing the token", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({ getPayload: () => ({}) } as never);

    let caught: unknown;
    try {
      await verifyGoogleIdToken({ idToken: "secret-id-token-contents", clientId: "client-id" });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("google.auth_failed");
    expect(JSON.stringify(caught)).not.toContain("secret-id-token-contents");
  });

  it("turns a signature or audience failure into google.auth_failed", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockRejectedValue(new Error("Wrong recipient"));

    await expectAppError(() => verifyGoogleIdToken({ idToken: "id-token", clientId: "client-id" }), "google.auth_failed");
  });
});
