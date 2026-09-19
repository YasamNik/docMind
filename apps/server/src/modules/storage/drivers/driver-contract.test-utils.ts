import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { expectAppError } from "../../../shared/test/errors.test-utils.js";
import type { StorageDriver, StorageLocation } from "../storage.types.js";

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

type DriverUnderTest = {
  driver: StorageDriver;
  // Definition level, not a method on the driver: production never has a driver
  // instance in hand when it asks this question, since a document can be off the
  // active storage entirely. Kept separate from makeDriver so a driver whose location
  // is derived from different settings than its client (S3's bucket versus its access
  // key, for example) is exercised the same way it runs in production.
  describeLocation: (args: { key: string }) => StorageLocation | Promise<StorageLocation>;
};

export function runDriverContractTests(name: string, makeDriver: () => Promise<DriverUnderTest>) {
  describe(`${name} driver contract`, () => {
    it("puts, reports existence, gets, and deletes", async () => {
      const { driver } = await makeDriver();
      const key = "user-1/doc-1/hello.txt";
      const { key: stored } = await driver.put({ key, body: Readable.from(["hello ", "world"]), mimeType: "text/plain" });
      expect(await driver.exists({ key: stored })).toBe(true);
      expect(await readAll(await driver.get({ key: stored }))).toBe("hello world");
      await driver.delete({ key: stored });
      expect(await driver.exists({ key: stored })).toBe(false);
    });

    it("reports a missing key as not found", async () => {
      const { driver } = await makeDriver();
      await expectAppError(() => driver.get({ key: "user-1/none/x.txt" }), "storage.not_found");
      expect(await driver.exists({ key: "user-1/none/x.txt" })).toBe(false);
    });

    it("passes its health check", async () => {
      const { driver } = await makeDriver();
      expect(await driver.healthCheck()).toMatchObject({ ok: true });
    });

    it("streams large bodies without buffering", async () => {
      const { driver } = await makeDriver();
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let produced = 0;
      const body = new Readable({
        read() {
          if (produced >= 8) return this.push(null);
          produced += 1;
          this.push(chunk);
        },
      });
      const { key } = await driver.put({ key: "user-1/doc-2/big.bin", body });
      let size = 0;
      for await (const c of await driver.get({ key })) size += (c as Buffer).length;
      expect(size).toBe(8 * 1024 * 1024);
      await driver.delete({ key });
    });

    it("describes the key put() actually returned, without touching the network", async () => {
      const { driver, describeLocation } = await makeDriver();
      // Production calls describeLocation with document.storageKey, which is whatever
      // put() handed back, not the key the caller asked for. For Google Drive those
      // differ (put() returns a fresh file id), so asserting against the literal input
      // key would pass without describeLocation ever seeing a real key.
      const { key: stored } = await driver.put({ key: "a/b/c.txt", body: Readable.from(["hello"]) });
      const location = await describeLocation({ key: stored });
      expect(location.label.length).toBeGreaterThan(0);
      expect(location.label).toContain(stored);
    });
  });
}
