import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  SETTINGS_ENCRYPTION_KEY: "a".repeat(64),
  AUTH_SECRET: "b".repeat(32),
};

describe("parseConfig", () => {
  it("applies defaults for optional values", () => {
    const config = parseConfig(valid);
    expect(config.port).toBe(4000);
    expect(config.databaseUrl).toBe("file:./docmind.sqlite");
    expect(config.serverBaseUrl).toBe("http://localhost:4000");
  });

  it("refuses to start without the encryption key and names the command", () => {
    expect(() => parseConfig({ AUTH_SECRET: valid.AUTH_SECRET })).toThrow(
      /SETTINGS_ENCRYPTION_KEY.*openssl rand -hex 32/s,
    );
  });

  it("rejects an encryption key that is not 32 bytes of hex", () => {
    expect(() => parseConfig({ ...valid, SETTINGS_ENCRYPTION_KEY: "abc" })).toThrow(
      /SETTINGS_ENCRYPTION_KEY/,
    );
  });

  it("parses PORT as a number", () => {
    expect(parseConfig({ ...valid, PORT: "5050" }).port).toBe(5050);
  });
});
