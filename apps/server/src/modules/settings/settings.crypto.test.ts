import { describe, expect, it } from "vitest";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { decryptSecret, encryptSecret } from "./settings.crypto.js";

const keyHex = "0f".repeat(32);

describe("settings crypto", () => {
  it("round trips a secret", () => {
    const ciphertext = encryptSecret({ plaintext: "sk-or-v1-abc", keyHex });
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(ciphertext).not.toContain("sk-or-v1-abc");
    expect(decryptSecret({ ciphertext, keyHex })).toBe("sk-or-v1-abc");
  });

  it("produces a different ciphertext each time", () => {
    const a = encryptSecret({ plaintext: "same", keyHex });
    const b = encryptSecret({ plaintext: "same", keyHex });
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext", async () => {
    const ciphertext = encryptSecret({ plaintext: "secret", keyHex });
    const parts = ciphertext.split(":");
    parts[4] = Buffer.from("xxxx").toString("base64");
    await expectAppError(() => decryptSecret({ ciphertext: parts.join(":"), keyHex }), "settings.bad_ciphertext");
  });

  it("rejects a value that is not in the enc:v1 format", async () => {
    await expectAppError(() => decryptSecret({ ciphertext: "plain", keyHex }), "settings.bad_ciphertext");
  });
});
