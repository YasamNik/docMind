import { describe, expect, it } from "vitest";
import { assertFetchableUrl, isPublicAddress } from "./link-fetch.models.js";

describe("isPublicAddress", () => {
  it("refuses loopback, private, link local and unique local addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(ip)).toBe(true);
    }
  });
});

describe("assertFetchableUrl", () => {
  it("accepts http and https", () => {
    expect(assertFetchableUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("refuses every other scheme", () => {
    for (const raw of ["file:///etc/passwd", "ftp://example.com", "data:text/html,hi", "javascript:alert(1)"]) {
      expect(() => assertFetchableUrl(raw)).toThrow(/refus/i);
    }
  });

  it("refuses a string that is not a url at all", () => {
    expect(() => assertFetchableUrl("not a url")).toThrow(/refus/i);
  });
});
