import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createError } from "../../shared/errors/errors.js";
import type { TelegramInlineKeyboard } from "./telegram.models.js";

// Bot API calls over plain fetch, in the shape of the google-drive client: three
// endpoints (getUpdates, getFile, sendMessage) are less surface than a Telegram SDK.
const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file";

// Telegram's own ceiling for what a bot can download through getFile. Above this the
// only workaround is running a local Bot API server, which is out of scope here.
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// getUpdates' own timeout parameter only tells Telegram how long to hold the
// connection open server side; it bounds nothing on this end. Every call carries a
// local AbortSignal too, so a connection that never answers cannot hang this client,
// and by extension the update poll loop that owns it, forever.
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
// Comfortably above getUpdates' own long poll wait, which this client passes as
// "timeout" in seconds: enough margin that ordinary network latency on top of a
// healthy long poll never trips the local deadline first.
const POLL_TIMEOUT_BUFFER_MS = 15_000;
// A getFile download can be up to TELEGRAM_MAX_DOWNLOAD_BYTES, far more than the
// small JSON bodies every other call exchanges, so it gets its own, larger allowance.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Narrower than the ambient fetch type: every call here sends either no body or a JSON
// string, never a Blob or FormData, and this is what the fake fetch in tests implements.
export type TelegramFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

const defaultFetch: TelegramFetch = (url, init) => fetch(url, init as RequestInit);

// Built from the method name and the status code only, never from the url or the
// response body. Telegram puts the bot token in the request path, so an error carrying
// the url would leak the token into whatever reads it: logs, a notification, a bug report.
function telegramError(method: string, status: number) {
  return createError({
    code: "telegram.api_error",
    message: `Telegram rejected the "${method}" call with status ${status}`,
    status: 502,
  });
}

function fileTooLargeError(sizeBytes: number) {
  const megabytes = (sizeBytes / (1024 * 1024)).toFixed(1);
  return createError({
    code: "telegram.file_too_large",
    message: `File is ${megabytes} MB, over Telegram's 20 MB download limit`,
    status: 413,
  });
}

type TelegramEnvelope<T> = { ok: boolean; result?: T; description?: string };

type TelegramFileInfo = {
  file_id: string;
  file_size?: number;
  file_path?: string;
};

export function createTelegramClient({
  token,
  fetchImpl = defaultFetch,
}: {
  token: string;
  fetchImpl?: TelegramFetch;
}) {
  async function callMethod<T>(method: string, body?: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw telegramError(method, response.status);
    const envelope = (await response.json()) as TelegramEnvelope<T>;
    if (!envelope.ok || envelope.result === undefined) throw telegramError(method, response.status);
    return envelope.result;
  }

  // Returns the updates straight out of the JSON envelope, unvalidated: the loop that
  // drives this client parses each one with telegramUpdateSchema before acting on it.
  async function getUpdates({ offset, timeoutSeconds }: { offset: number; timeoutSeconds: number }) {
    return callMethod<unknown[]>("getUpdates", { offset, timeout: timeoutSeconds }, timeoutSeconds * 1000 + POLL_TIMEOUT_BUFFER_MS);
  }

  async function getFile({ fileId }: { fileId: string }) {
    const info = await callMethod<TelegramFileInfo>("getFile", { file_id: fileId });
    if (typeof info.file_size === "number" && info.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      throw fileTooLargeError(info.file_size);
    }
    if (!info.file_path) throw telegramError("getFile", 502);

    const response = await fetchImpl(`${TELEGRAM_FILE_BASE}/bot${token}/${info.file_path}`, {
      method: "GET",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw telegramError("getFile", response.status);

    return {
      stream: Readable.fromWeb(response.body as WebReadableStream),
      fileName: info.file_path.split("/").pop() || info.file_path,
      sizeBytes: info.file_size,
    };
  }

  async function sendMessage({ chatId, text, replyMarkup }: { chatId: number; text: string; replyMarkup?: TelegramInlineKeyboard }) {
    await callMethod<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  // Stops the button's own loading spinner. text is a short toast Telegram shows the
  // user, omitted entirely when there is nothing worth surfacing beyond the ordinary
  // reply that already follows (assistant confirmation plan, Decision 11).
  async function answerCallbackQuery({ callbackQueryId, text }: { callbackQueryId: string; text?: string }): Promise<void> {
    await callMethod<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  // Sends no reply_markup at all, which is how Telegram is told to remove whatever
  // keyboard the message currently has, rather than replace it with another one.
  async function editMessageReplyMarkup({ chatId, messageId }: { chatId: number; messageId: number }): Promise<void> {
    await callMethod<{ message_id: number } | boolean>("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  return { getUpdates, getFile, sendMessage, answerCallbackQuery, editMessageReplyMarkup };
}

export type TelegramClient = ReturnType<typeof createTelegramClient>;
