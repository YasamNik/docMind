import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker as createTesseractWorker, type Worker } from "tesseract.js";

export type OcrEngine = {
  recognize(bytes: Uint8Array, opts: { languages: string; dataDir: string }): Promise<string>;
  terminate(): Promise<void>;
};

export function createTesseractEngine(deps?: { createWorker?: typeof createTesseractWorker }): OcrEngine {
  const createWorker = deps?.createWorker ?? createTesseractWorker;
  const workers = new Map<string, Promise<Worker>>();

  function workerFor(languages: string, dataDir: string) {
    const cachePath = resolve(dataDir, "tessdata");
    const key = `${languages}|${cachePath}`;
    const cached = workers.get(key);
    if (cached) {
      return cached;
    }
    const pending = (async () => {
      await mkdir(cachePath, { recursive: true });
      return createWorker(languages, 1, { cachePath, langPath: "https://tessdata.projectnaptha.com/4.0.0_fast" });
    })();
    // Evict a failed worker-creation promise so a later call can retry
    // instead of being stuck with a permanently rejected cache entry.
    pending.catch(() => {
      workers.delete(key);
    });
    workers.set(key, pending);
    return pending;
  }

  return {
    async recognize(bytes, { languages, dataDir }) {
      const worker = await workerFor(languages, dataDir);
      const result = await worker.recognize(Buffer.from(bytes));
      return result.data.text;
    },
    async terminate() {
      const entries = [...workers.values()];
      try {
        const settled = await Promise.allSettled(entries);
        const resolvedWorkers = settled
          .filter((r): r is PromiseFulfilledResult<Worker> => r.status === "fulfilled")
          .map((r) => r.value);
        await Promise.allSettled(resolvedWorkers.map((worker) => worker.terminate()));
      } finally {
        workers.clear();
      }
    },
  };
}
