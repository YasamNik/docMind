import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import * as v from "valibot";
import { isAppError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { fetchReadablePage } from "./link-fetch.js";
import { createTelegramClient, type TelegramClient } from "./telegram.client.js";
import {
  compressedPhotoNotice,
  duplicateReply,
  fileDocumentName,
  fileTooLargeReply,
  finishedDocumentReply,
  intentOf,
  linkDocumentBody,
  linkDocumentName,
  pairingSucceededReply,
  receivedReply,
  textDocumentName,
  type TelegramIntent,
} from "./telegram.models.js";
import { telegramUpdateSchema, type TelegramMessage, type TelegramUpdate } from "./telegram.schemas.js";

// Own poll loop in the shape of jobs.runner.ts: re-reads its token every cycle instead
// of reacting to a settings write, because settingsService has no post-write hook.

type ClientFactory = (args: { token: string }) => TelegramClient;

function readUpdateId(raw: unknown): number | undefined {
  if (raw && typeof raw === "object" && "update_id" in raw) {
    const value = (raw as { update_id: unknown }).update_id;
    if (typeof value === "number") return value;
  }
  return undefined;
}

// Both sides hashed to the same fixed length first so a mismatch in length never
// shows up as a mismatch in comparison time, then compared with timingSafeEqual so a
// mismatch in content does not either. An unpaired bot must leak nothing about
// whether a guess was close.
function codesMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 60000);
}

export type FetchLinkPage = (args: { url: string }) => Promise<{ title: string; text: string; finalUrl: string }>;

export function createTelegramService({
  db,
  settingsService,
  documentsService,
  getUserId,
  clientFactory = createTelegramClient,
  fetchLinkPage = fetchReadablePage,
  logger = createLogger("telegram"),
  pollTimeoutSeconds = 25,
  idleIntervalMs = 1000,
  appBaseUrl = "http://localhost:5173",
}: {
  db: Database;
  settingsService: SettingsService;
  documentsService: DocumentsService;
  // There is exactly one Telegram-paired account, and this loop runs with no HTTP
  // session to read it from. Resolved fresh every cycle so a user created after the
  // process started is picked up without a restart, the same way the token is.
  getUserId: () => Promise<string | undefined>;
  clientFactory?: ClientFactory;
  // Injectable so tests can save a link with no dispatcher, no DNS lookup and no
  // network at all. link-fetch.ts owns the real guard and has its own test suite.
  fetchLinkPage?: FetchLinkPage;
  logger?: Logger;
  pollTimeoutSeconds?: number;
  idleIntervalMs?: number;
  // Where the app is reachable from a phone, so the second reply can link straight to
  // the document rather than just naming it.
  appBaseUrl?: string;
}) {
  // Read directly rather than through documentsService: the second reply asks a
  // question ("which of my documents just finished") no route or upload flow needs,
  // so it has no home in the usecases layer documentsService already covers.
  const documentsRepository = createDocumentsRepository({ db });
  let running = false;
  let loop: Promise<void> | null = null;

  async function tryPair({
    userId,
    client,
    chatId,
    fromId,
    fromName,
    code,
  }: {
    userId: string;
    client: TelegramClient;
    chatId: number;
    fromId: number;
    fromName: string;
    code: string;
  }) {
    const storedCode = await settingsService.get<string>(userId, "telegram.pairingCode");
    if (!storedCode || !codesMatch(code, storedCode)) return;
    await settingsService.setInternal(userId, "telegram.pairedUserId", fromId);
    await settingsService.setInternal(userId, "telegram.pairedName", fromName);
    await settingsService.setInternal(userId, "telegram.pairingCode", "");
    await client.sendMessage({ chatId, text: pairingSucceededReply() });
  }

  async function handleFile({
    userId,
    client,
    chatId,
    message,
    intent,
  }: {
    userId: string;
    client: TelegramClient;
    chatId: number;
    message: TelegramMessage;
    intent: Extract<TelegramIntent, { kind: "file" }>;
  }) {
    let downloaded: Awaited<ReturnType<TelegramClient["getFile"]>>;
    try {
      downloaded = await client.getFile({ fileId: intent.fileId });
    } catch (error) {
      if (isAppError(error) && error.code === "telegram.file_too_large") {
        await client.sendMessage({ chatId, text: fileTooLargeReply() });
        return;
      }
      throw error;
    }

    const name = fileDocumentName({ intent, caption: message.caption, messageId: message.message_id, now: new Date() });
    const { document, duplicateOf } = await documentsService.upload({
      userId,
      name,
      mimeType: intent.mimeType,
      body: downloaded.stream,
      source: "telegram",
    });

    await client.sendMessage({ chatId, text: duplicateOf ? duplicateReply(document.name) : receivedReply(document.name) });

    if (intent.compressedPhoto) {
      const alreadySent = await settingsService.get<boolean>(userId, "telegram.compressedPhotoNoticeSent");
      if (!alreadySent) {
        await client.sendMessage({ chatId, text: compressedPhotoNotice() });
        await settingsService.setInternal(userId, "telegram.compressedPhotoNoticeSent", true);
      }
    }
  }

  async function handleLink({ userId, client, chatId, url }: { userId: string; client: TelegramClient; chatId: number; url: string }) {
    let page: Awaited<ReturnType<FetchLinkPage>>;
    try {
      page = await fetchLinkPage({ url });
    } catch (error) {
      if (isAppError(error) && error.code === "telegram.link_refused") {
        await client.sendMessage({ chatId, text: error.message });
        return;
      }
      throw error;
    }

    const { document, duplicateOf } = await documentsService.upload({
      userId,
      name: linkDocumentName({ title: page.title, url: page.finalUrl }),
      mimeType: "text/plain",
      body: Readable.from([linkDocumentBody({ url: page.finalUrl, text: page.text })]),
      source: "telegram",
    });
    await client.sendMessage({ chatId, text: duplicateOf ? duplicateReply(document.name) : receivedReply(document.name) });
  }

  async function handleText({ userId, client, chatId, text }: { userId: string; client: TelegramClient; chatId: number; text: string }) {
    const { document, duplicateOf } = await documentsService.upload({
      userId,
      name: textDocumentName(text),
      mimeType: "text/plain",
      body: Readable.from([text]),
      source: "telegram",
    });
    await client.sendMessage({ chatId, text: duplicateOf ? duplicateReply(document.name) : receivedReply(document.name) });
  }

  async function handleUpdate({ userId, client, update }: { userId: string; client: TelegramClient; update: TelegramUpdate }) {
    const message = update.message;
    if (!message || message.from === undefined) return;
    const fromId = message.from.id;
    const chatId = message.chat.id;

    const pairedUserId = await settingsService.get<number>(userId, "telegram.pairedUserId");
    const paired = pairedUserId !== undefined;
    const intent = intentOf(update, { paired });

    if (!paired) {
      // Every message except a correct code is ignored with no reply at all here: an
      // unpaired bot must not confirm it received anything, or a stranger who found
      // the bot's username learns it does something worth guessing at.
      if (intent.kind === "pairing") {
        await tryPair({ userId, client, chatId, fromId, fromName: message.from.first_name, code: intent.code });
      }
      return;
    }

    if (fromId !== pairedUserId) return;

    if (intent.kind === "file") {
      await handleFile({ userId, client, chatId, message, intent });
      return;
    }
    if (intent.kind === "text") {
      await handleText({ userId, client, chatId, text: intent.text });
      return;
    }
    if (intent.kind === "link") {
      await handleLink({ userId, client, chatId, url: intent.url });
      return;
    }
    // "pairing" while already paired, or "ignore": nothing to do.
  }

  // Extraction fans jobs out rather than chaining them, and the runner has no
  // completion hook, so there is no end of a chain to notify from. This asks, once a
  // cycle, which of the bot's own documents have both finished, and reports each one
  // it has not reported yet. embeddingStatus is left out of listFinishedSince on
  // purpose: it changes what search can find, never what this message would say.
  async function reportFinishedDocuments({ userId, client }: { userId: string; client: TelegramClient }) {
    const pairedUserId = await settingsService.get<number>(userId, "telegram.pairedUserId");
    if (pairedUserId === undefined) return;

    const stored = await settingsService.get<string>(userId, "telegram.lastReportedAt");
    const isFirstRun = !stored;
    // A brand new watcher must not announce the whole existing library the moment
    // someone pairs, so it starts its watermark at now and only reports what finishes
    // after that, the same way a new subscriber does not get every past post at once.
    const since = isFirstRun ? new Date().toISOString() : stored;
    if (isFirstRun) await settingsService.setInternal(userId, "telegram.lastReportedAt", since);

    const finished = await documentsRepository.listFinishedSince({ userId, source: "telegram", since });
    for (const document of finished) {
      const text = finishedDocumentReply({
        name: document.name,
        categoryPath: document.categoryPath,
        tagNames: document.tags.map((tag) => tag.name),
        documentUrl: `${appBaseUrl}/documents/${document.id}`,
        ruleFailed: document.ruleStatus === "failed",
        summaryFailed: document.summaryStatus === "failed",
      });
      await client.sendMessage({ chatId: pairedUserId, text });
    }

    const last = finished.at(-1);
    if (last) await settingsService.setInternal(userId, "telegram.lastReportedAt", last.createdAt);
  }

  async function runOnce(): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    const token = await settingsService.get<string>(userId, "telegram.botToken");
    if (!token) return;

    const client = clientFactory({ token });
    const lastUpdateId = (await settingsService.get<number>(userId, "telegram.lastUpdateId")) ?? 0;
    const updates = await client.getUpdates({ offset: lastUpdateId + 1, timeoutSeconds: pollTimeoutSeconds });

    for (const raw of updates) {
      const parsed = v.safeParse(telegramUpdateSchema, raw);
      // A crash while handling one update must not replay updates already confirmed:
      // the cursor advances right here, after this one is fully handled, not once for
      // the whole batch. A thrown error skips the advance below and stops the loop for
      // this cycle, so Telegram redelivers exactly this update and nothing earlier.
      if (parsed.success) await handleUpdate({ userId, client, update: parsed.output });

      const updateId = readUpdateId(raw);
      if (updateId !== undefined) await settingsService.setInternal(userId, "telegram.lastUpdateId", updateId);
    }

    await reportFinishedDocuments({ userId, client });
  }

  async function start() {
    // Telegram answers a second concurrent getUpdates for the same token with a 409,
    // so this guard is not optional: it is what keeps there being only one poller.
    if (running) return;
    running = true;
    loop = (async () => {
      let attempt = 0;
      while (running) {
        try {
          await runOnce();
          attempt = 0;
        } catch (error) {
          attempt += 1;
          logger.warn({ err: (error as Error).message, attempt }, "Telegram poll cycle failed");
        }
        if (!running) break;
        const waitMs = attempt > 0 ? backoffDelayMs(attempt) : idleIntervalMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    })();
  }

  async function stop() {
    running = false;
    await loop;
    loop = null;
  }

  return { runOnce, start, stop };
}

export type TelegramService = ReturnType<typeof createTelegramService>;
