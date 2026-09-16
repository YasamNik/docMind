import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTesseractEngine } from "./ocr.js";

describe("createTesseractEngine", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "docmind-ocr-"));
  });

  it("evicts a failed worker so a later call for the same language can retry", async () => {
    let attempts = 0;
    const fakeWorker = { recognize: vi.fn(async () => ({ data: { text: "ok" } })), terminate: vi.fn(async () => {}) };
    const createWorker = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("network hiccup");
      }
      return fakeWorker as never;
    });
    const engine = createTesseractEngine({ createWorker: createWorker as never });

    await expect(engine.recognize(new Uint8Array(), { languages: "eng", dataDir })).rejects.toThrow(
      "network hiccup",
    );
    await expect(engine.recognize(new Uint8Array(), { languages: "eng", dataDir })).resolves.toBe("ok");
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it("reuses the worker across recognize calls with the same language", async () => {
    const fakeWorker = { recognize: vi.fn(async () => ({ data: { text: "ok" } })), terminate: vi.fn(async () => {}) };
    const createWorker = vi.fn(async () => fakeWorker as never);
    const engine = createTesseractEngine({ createWorker: createWorker as never });

    await engine.recognize(new Uint8Array(), { languages: "eng", dataDir });
    await engine.recognize(new Uint8Array(), { languages: "eng", dataDir });

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(fakeWorker.recognize).toHaveBeenCalledTimes(2);
  });

  it("resolves terminate even when a worker failed to create, terminates the resolved worker, and creates a fresh worker afterward", async () => {
    const okWorker = { recognize: vi.fn(async () => ({ data: { text: "ok" } })), terminate: vi.fn(async () => {}) };
    let createCalls = 0;
    const createWorker = vi.fn(async (languages?: unknown) => {
      createCalls += 1;
      if (languages === "fail") {
        throw new Error("boom");
      }
      return okWorker as never;
    });
    const engine = createTesseractEngine({ createWorker: createWorker as never });

    // Fire both calls, and terminate, synchronously so the map still holds
    // both the failing and the resolved worker-creation promises when
    // terminate() reads them.
    const failing = engine.recognize(new Uint8Array(), { languages: "fail", dataDir }).catch(() => "failed" as const);
    const ok = engine.recognize(new Uint8Array(), { languages: "eng", dataDir });
    const terminatePromise = engine.terminate();

    await expect(terminatePromise).resolves.toBeUndefined();
    await expect(ok).resolves.toBe("ok");
    await expect(failing).resolves.toBe("failed");
    expect(okWorker.terminate).toHaveBeenCalledTimes(1);

    const callsBeforeRetry = createCalls;
    await engine.recognize(new Uint8Array(), { languages: "eng", dataDir });
    expect(createCalls).toBe(callsBeforeRetry + 1);
  });
});
