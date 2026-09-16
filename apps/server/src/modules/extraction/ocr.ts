import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker, type Worker } from "tesseract.js";

export type OcrEngine = {
  recognize(bytes: Uint8Array, opts: { languages: string; dataDir: string }): Promise<string>;
  terminate(): Promise<void>;
};

export function createTesseractEngine(): OcrEngine {
  const workers = new Map<string, Promise<Worker>>();

  async function workerFor(languages: string, dataDir: string) {
    const cachePath = resolve(dataDir, "tessdata");
    const key = `${languages}|${cachePath}`;
    let pending = workers.get(key);
    if (!pending) {
      pending = (async () => {
        await mkdir(cachePath, { recursive: true });
        return createWorker(languages, 1, { cachePath, langPath: "https://tessdata.projectnaptha.com/4.0.0_fast" });
      })();
      workers.set(key, pending);
    }
    return pending;
  }

  return {
    async recognize(bytes, { languages, dataDir }) {
      const worker = await workerFor(languages, dataDir);
      const result = await worker.recognize(Buffer.from(bytes));
      return result.data.text;
    },
    async terminate() {
      await Promise.all([...workers.values()].map(async (p) => (await p).terminate()));
      workers.clear();
    },
  };
}
