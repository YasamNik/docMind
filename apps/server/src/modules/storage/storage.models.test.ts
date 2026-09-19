import { describe, expect, it } from "vitest";
import { buildOAuthRedirectUri, signOAuthState, signState, verifyOAuthState, verifyState } from "./storage.models.js";

const secretHex = "11".repeat(32);

describe("oauth redirect uri", () => {
  it("builds the callback url for a driver from the request origin", () => {
    expect(buildOAuthRedirectUri({ origin: "https://docmind.example.com", driverId: "googleDrive" })).toBe(
      "https://docmind.example.com/api/storage/drivers/googleDrive/callback",
    );
  });
});

describe("oauth state", () => {
  it("round trips the user and driver it was issued for", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    expect(verifyOAuthState({ state, secretHex })).toEqual({ userId: "user_1", driverId: "googleDrive" });
  });

  it("rejects a state whose payload was edited", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    const [payload, signature] = state.split(".");
    const tampered = `${Buffer.from(Buffer.from(payload!, "base64url").toString().replace("user_1", "user_2")).toString("base64url")}.${signature}`;
    expect(() => verifyOAuthState({ state: tampered, secretHex })).toThrow(/invalid/i);
  });

  it("rejects a state signed with a different key", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    expect(() => verifyOAuthState({ state, secretHex: "22".repeat(32) })).toThrow(/invalid/i);
  });

  it("rejects a state older than ten minutes", () => {
    const issued = new Date("2026-09-18T12:00:00.000Z");
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex, now: issued });
    const late = new Date("2026-09-18T12:10:01.000Z");
    expect(() => verifyOAuthState({ state, secretHex, now: late })).toThrow(/expired/i);
  });
});

describe("purpose carrying state", () => {
  it("round trips any purpose, not only a storage driver id", () => {
    const state = signState({ userId: "user_1", purpose: "email:gmail", secretHex });
    expect(verifyState({ state, secretHex })).toEqual({ userId: "user_1", purpose: "email:gmail" });
  });

  it("verifyOAuthState rejects a state signed for a non-storage purpose", () => {
    const state = signState({ userId: "user_1", purpose: "email:gmail", secretHex });
    expect(() => verifyOAuthState({ state, secretHex })).toThrow(/invalid/i);
  });

  it("a storage purpose still round trips through the generic verifier", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    expect(verifyState({ state, secretHex })).toEqual({ userId: "user_1", purpose: "storage:googleDrive" });
  });
});
