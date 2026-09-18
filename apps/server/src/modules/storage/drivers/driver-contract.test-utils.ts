import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { expectAppError } from "../../../shared/test/errors.test-utils.js";
import type { StorageDriver } from "../storage.types.js";

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function runDriverContractTests(name: string, makeDriver: () => Promise<StorageDriver>) {
  describe(`${name} driver contract`, () => {
    it("puts, reports existence, gets, and deletes", async () => {
      const driver = await makeDriver();
      const key = "user-1/doc-1/hello.txt";
      const { key: stored } = await driver.put({ key, body: Readable.from(["hello ", "world"]), mimeType: "text/plain" });
      expect(await driver.exists({ key: stored })).toBe(true);
      expect(await readAll(await driver.get({ key: stored }))).toBe("hello world");
      await driver.delete({ key: stored });
      expect(await driver.exists({ key: stored })).toBe(false);
    });

    it("reports a missing key as not found", async () => {
      const driver = await makeDriver();
      await expectAppError(() => driver.get({ key: "user-1/none/x.txt" }), "storage.not_found");
      expect(await driver.exists({ key: "user-1/none/x.txt" })).toBe(false);
    });

    it("passes its health check", async () => {
      const driver = await makeDriver();
      expect(await driver.healthCheck()).toMatchObject({ ok: true });
    });

    it("streams large bodies without buffering", async () => {
      const driver = await makeDriver();
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

    it("describes a stored key without touching the network", async () => {
      const driver = await makeDriver();
      await driver.put({ key: "a/b/c.txt", body: Readable.from(["hello"]) });
      const location = driver.describeLocation({ key: "a/b/c.txt" });
      expect(location.label.length).toBeGreaterThan(0);
      expect(location.label).toContain("c.txt");
    });
  });
}
