import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createTelegramClient, type TelegramFetch } from "./telegram.client.js";

const TOKEN = "111:abcTestToken";

function readAllChunks(stream: Readable) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk as Buffer)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("createTelegramClient", () => {
  it("asks for updates from the offset and returns the parsed ones", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: TelegramFetch = async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 10 }, { update_id: 11 }] }), { status: 200 });
    };
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    const updates = await client.getUpdates({ offset: 10, timeoutSeconds: 25 });

    expect(updates).toEqual([{ update_id: 10 }, { update_id: 11 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0]!.body).toMatchObject({ offset: 10, timeout: 25 });
  });

  it("keeps the bot token out of the error it throws", async () => {
    const client = createTelegramClient({ token: "123:SECRET", fetchImpl: async () => new Response("nope", { status: 401 }) });

    await expect(client.getUpdates({ offset: 0, timeoutSeconds: 0 })).rejects.toThrow(/telegram/i);
    await expect(client.getUpdates({ offset: 0, timeoutSeconds: 0 })).rejects.not.toThrow(/SECRET/);
  });

  it("refuses a file above Telegram's twenty megabyte download ceiling", async () => {
    let downloadCalled = false;
    const fetchImpl: TelegramFetch = async (url) => {
      if (url.includes("/file/bot")) {
        downloadCalled = true;
        return new Response("bytes", { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: "big-file", file_size: 21 * 1024 * 1024, file_path: "documents/big.pdf" } }),
        { status: 200 },
      );
    };
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await expectAppError(() => client.getFile({ fileId: "big-file" }), "telegram.file_too_large");
    expect(downloadCalled).toBe(false);
  });

  it("downloads a file under the ceiling as a stream with its reported size", async () => {
    const fetchImpl: TelegramFetch = async (url) => {
      if (url.includes("/file/bot")) return new Response("hello receipt", { status: 200 });
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: "small-file", file_size: 13, file_path: "documents/receipt.pdf" } }),
        { status: 200 },
      );
    };
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    const file = await client.getFile({ fileId: "small-file" });

    expect(file.fileName).toBe("receipt.pdf");
    expect(file.sizeBytes).toBe(13);
    await expect(readAllChunks(file.stream)).resolves.toEqual(Buffer.from("hello receipt"));
  });

  it("gives getUpdates a local deadline comfortably longer than the long poll wait it asks Telegram for", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl: TelegramFetch = async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.getUpdates({ offset: 0, timeoutSeconds: 25 });

    // pollTimeoutSeconds only tells Telegram how long to hold the connection open; it
    // bounds nothing on this end, so the local deadline must sit comfortably above it
    // or ordinary network latency on a healthy long poll would trip it first.
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy.mock.calls[0]![0]).toBeGreaterThan(25_000);
    timeoutSpy.mockRestore();
  });

  it("attaches a local abort signal to every call, so none of them can hang forever", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl: TelegramFetch = async (url, init) => {
      signals.push(init.signal);
      if (url.includes("/file/bot")) return new Response("bytes", { status: 200 });
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: "f", file_size: 5, file_path: "documents/note.txt" } }),
        { status: 200 },
      );
    };
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.getFile({ fileId: "f" });
    await client.sendMessage({ chatId: 1, text: "hi" });

    // One call for getFile's info request, one for the file download, one for sendMessage.
    expect(signals).toHaveLength(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    }
  });

  it("sends a message to a chat", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: TelegramFetch = async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    };
    const client = createTelegramClient({ token: TOKEN, fetchImpl });

    await client.sendMessage({ chatId: 42, text: "Got it." });

    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body).toMatchObject({ chat_id: 42, text: "Got it." });
  });
});
