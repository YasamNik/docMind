import { describe, expect, it } from "vitest";
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

  it("rejects tampered ciphertext", () => {
    const ciphertext = encryptSecret({ plaintext: "secret", keyHex });
    const parts = ciphertext.split(":");
    parts[4] = Buffer.from("xxxx").toString("base64");
    expect(() => decryptSecret({ ciphertext: parts.join(":"), keyHex })).toThrow(/bad_ciphertext/);
  });

  it("rejects a value that is not in the enc:v1 format", () => {
    expect(() => decryptSecret({ ciphertext: "plain", keyHex })).toThrow(/bad_ciphertext/);
  });
});
