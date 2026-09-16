import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { expectAppError } from "../../../../shared/test/errors.test-utils.js";
import { runDriverContractTests } from "../driver-contract.test-utils.js";
import { createLocalDriver } from "./local.driver.js";

const roots: string[] = [];
async function makeDriver() {
  const root = await mkdtemp(join(tmpdir(), "docmind-local-"));
  roots.push(root);
  return createLocalDriver({ root });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

runDriverContractTests("local", makeDriver);

describe("local driver safety", () => {
  it("rejects keys that escape the root", async () => {
    const driver = await makeDriver();
    await expectAppError(() => driver.put({ key: "../escape.txt", body: Readable.from(["x"]) }), "storage.invalid_key");
    await expectAppError(() => driver.get({ key: "user-1/../../etc/passwd" }), "storage.invalid_key");
  });

  it("rejects absolute keys", async () => {
    const driver = await makeDriver();
    await expectAppError(() => driver.exists({ key: "/etc/passwd" }), "storage.invalid_key");
  });
});
