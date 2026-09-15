import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createError } from "../../shared/errors/errors.js";

const PREFIX = "enc:v1";

function badCiphertext() {
  return createError({
    code: "settings.bad_ciphertext",
    message: "settings.bad_ciphertext: Stored secret could not be decrypted. Was SETTINGS_ENCRYPTION_KEY changed?",
    status: 500,
  });
}

export function encryptSecret({ plaintext, keyHex }: { plaintext: string; keyHex: string }) {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret({ ciphertext, keyHex }: { ciphertext: string; keyHex: string }) {
  const parts = ciphertext.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== PREFIX) throw badCiphertext();
  try {
    const key = Buffer.from(keyHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2]!, "base64"));
    decipher.setAuthTag(Buffer.from(parts[3]!, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[4]!, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw badCiphertext();
  }
}

export function isEncrypted(value: string) {
  return value.startsWith(`${PREFIX}:`);
}
