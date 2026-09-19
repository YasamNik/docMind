import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import * as v from "valibot";
import { isAppError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { TELEGRAM_ASSISTANT_SYSTEM_PROMPT } from "../chat/chat.models.js";
import type { ChatService } from "../chat/chat.usecases.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { fetchReadablePage } from "./link-fetch.js";
import { createTelegramClient, type TelegramClient } from "./telegram.client.js";
import {
  acknowledgementReply,
  assistantReplyText,
  compressedPhotoNotice,
  duplicateReply,
  fileDocumentName,
  fileTooLargeReply,
  finishedDocumentReply,
  intentOf,
  isCheapMessage,
  linkDocumentBody,
  linkDocumentName,
  missingNoteTextReply,
  newThreadReply,
  notesMovedNotice,
  pairingSucceededReply,
  receivedReply,
  splitForTelegram,
  stripCitationMarkers,
  textDocumentName,
  type TelegramIntent,
} from "./telegram.models.js";
import { telegramUpdateSchema, type TelegramMessage, type TelegramUpdate } from "./telegram.schemas.js";

// Only what the assistant turn actually calls: creating a session and sending a
// message. Kept narrow on purpose so a test can hand this a chat service backed by a
// fake AI adapter without also standing in for every route chat.usecases.ts serves.
type TelegramChatService = Pick<ChatService, "createSession" | "sendMessage">;

// Own poll loop in the shape of jobs.runner.ts: re-reads its token every cycle instead
// of reacting to a settings write, because settingsService has no post-write hook.
// Two such loops run side by side, one for the long update poll and one for the
// finished-document notifier, so a quiet chat holding the poll open for up to
// pollTimeoutSeconds never delays the notifier's own short cycle.

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

// A short, capped delay between retries of the same update, distinct from
// backoffDelayMs above: that one paces whole failed cycles up to a minute apart, this
// one only smooths over a blip such as one failed sendMessage call, so it stays under
// a couple of seconds even at its ceiling.
function defaultUpdateRetryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 2000);
}

export type FetchLinkPage = (args: { url: string }) => Promise<{ title: string; text: string; finalUrl: string }>;

export function createTelegramService({
  db,
  settingsService,
  documentsService,
  chatService,
  getUserId,
  clientFactory = createTelegramClient,
  fetchLinkPage = fetchReadablePage,
  logger = createLogger("telegram"),
  pollTimeoutSeconds = 25,
  idleIntervalMs = 1000,
  notifyIntervalMs = 3000,
  appBaseUrl = "http://localhost:5173",
  // Matches the jobs module's own default maxAttempts, so the retry policy for a
  // failing background unit of work is the same number everywhere in the app.
  updateRetryAttempts = 3,
  updateRetryDelayMs = defaultUpdateRetryDelayMs,
  shutdownTimeoutMs = 5000,
}: {
  db: Database;
  settingsService: SettingsService;
  documentsService: DocumentsService;
  // The same chat service the app's own chat page uses: retrieval, history and
  // citations are its implementation, not a second one grown here. The assistant
  // passes its own system prompt (TELEGRAM_ASSISTANT_SYSTEM_PROMPT) on every call.
  chatService: TelegramChatService;
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
  // How often the finished-document notifier looks for new work, on its own clock.
  // getUpdates can hold a connection open for pollTimeoutSeconds, and the notifier
  // must not wait behind it, so this is unrelated to idleIntervalMs on purpose.
  notifyIntervalMs?: number;
  // Where the app is reachable from a phone, so the second reply can link straight to
  // the document rather than just naming it.
  appBaseUrl?: string;
  // How many times a single update is retried, in place, before pollUpdatesOnce gives
  // up and skips it. Bounded so one message that always fails, or a sendMessage that
  // always errors because the user blocked the bot, can cost at most itself rather than
  // jamming every later update behind it forever.
  updateRetryAttempts?: number;
  // Delay before each retry, by attempt number starting at 1. Overridable so a test
  // exercising a poisoned update does not have to sit through real delays.
  updateRetryDelayMs?: (attempt: number) => number;
  // How long stop() waits for both loops to finish their current cycle before it gives
  // up on the wait. A getUpdates call or a send that never returns must not keep the
  // process's shutdown handler from ever completing: index.ts calls process.exit right
  // after stop() regardless, so a loop still running past this deadline costs nothing.
  shutdownTimeoutMs?: number;
}) {
  // Read directly rather than through documentsService: the second reply asks a
  // question ("which of my documents just finished") no route or upload flow needs,
  // so it has no home in the usecases layer documentsService already covers.
  const documentsRepository = createDocumentsRepository({ db });
  let running = false;
  let pollLoop: Promise<void> | null = null;
  let notifyLoop: Promise<void> | null = null;

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

  // /note does exactly what plain text used to do: the code moved, the behavior did
  // not. Empty text (the whole point of /note typed with nothing after it) asks for
  // the note rather than filing a blank document.
  async function handleNote({ userId, client, chatId, text }: { userId: string; client: TelegramClient; chatId: number; text: string }) {
    const trimmed = text.trim();
    if (!trimmed) {
      await client.sendMessage({ chatId, text: missingNoteTextReply() });
      return;
    }
    const { document, duplicateOf } = await documentsService.upload({
      userId,
      name: textDocumentName(trimmed),
      mimeType: "text/plain",
      body: Readable.from([trimmed]),
      source: "telegram",
    });
    await client.sendMessage({ chatId, text: duplicateOf ? duplicateReply(document.name) : receivedReply(document.name) });
  }

  // Said once, ever, the first time plain text arrives after notes moved behind /note.
  async function noteMigrationNoticeIfDue({ userId, client, chatId }: { userId: string; client: TelegramClient; chatId: number }) {
    const alreadySent = await settingsService.get<boolean>(userId, "telegram.noteMigrationNoticeSent");
    if (alreadySent) return;
    await client.sendMessage({ chatId, text: notesMovedNotice() });
    await settingsService.setInternal(userId, "telegram.noteMigrationNoticeSent", true);
  }

  // One Telegram chat maps to one active chat session, so the same conversation is
  // visible on the app's own chat page afterwards. Created lazily on the first turn
  // and cleared by /new, never by anything else.
  async function ensureChatSession({ userId }: { userId: string }): Promise<string> {
    const existing = await settingsService.get<string>(userId, "telegram.chatSessionId");
    if (existing) return existing;
    const session = await chatService.createSession({ userId });
    await settingsService.setInternal(userId, "telegram.chatSessionId", session.id);
    return session.id;
  }

  // Runs one turn of the assistant conversation through the app's own chat service,
  // with its own system prompt so it talks like a person instead of refusing when no
  // document matched. streamChat has no token stream on Telegram's side, so the reply
  // is consumed to completion here and sent as one message, split if it runs long.
  async function handleAssistantTurn({ userId, client, chatId, text }: { userId: string; client: TelegramClient; chatId: number; text: string }) {
    const trimmed = text.trim();
    if (isCheapMessage(trimmed)) {
      await client.sendMessage({ chatId, text: acknowledgementReply() });
      return;
    }

    const sessionId = await ensureChatSession({ userId });
    const generator = await chatService.sendMessage({ userId, sessionId, content: trimmed, systemPrompt: TELEGRAM_ASSISTANT_SYSTEM_PROMPT });

    let fullText = "";
    let sourceNames: string[] = [];
    let errorMessage: string | undefined;
    for await (const event of generator) {
      if (event.event === "token") fullText += event.data;
      else if (event.event === "done") sourceNames = event.data.citations.map((c) => c.documentName);
      else if (event.event === "error") errorMessage = event.data.message;
    }

    const reply = errorMessage ?? assistantReplyText({ answer: stripCitationMarkers(fullText), sourceNames });
    for (const part of splitForTelegram(reply)) {
      await client.sendMessage({ chatId, text: part });
    }
  }

  async function handleNewThread({ userId, client, chatId }: { userId: string; client: TelegramClient; chatId: number }) {
    await settingsService.setInternal(userId, "telegram.chatSessionId", "");
    await client.sendMessage({ chatId, text: newThreadReply() });
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
    if (intent.kind === "note") {
      await handleNote({ userId, client, chatId, text: intent.text });
      return;
    }
    if (intent.kind === "link") {
      await handleLink({ userId, client, chatId, url: intent.url });
      return;
    }
    if (intent.kind === "newThread") {
      await handleNewThread({ userId, client, chatId });
      return;
    }
    // /web reuses the same conversation for now; live web search is a later change
    // that attaches to this same turn only for that command.
    if (intent.kind === "web") {
      await handleAssistantTurn({ userId, client, chatId, text: intent.text });
      return;
    }
    if (intent.kind === "chat") {
      await handleAssistantTurn({ userId, client, chatId, text: intent.text });
      // Plain text used to become a note, so the first time this fires the bot also
      // says where notes went. /web is an explicit new command, not the old habit,
      // so it never triggers this.
      await noteMigrationNoticeIfDue({ userId, client, chatId });
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

    const storedAt = await settingsService.get<string>(userId, "telegram.lastReportedAt");
    const isFirstRun = !storedAt;
    // A brand new watcher must not announce the whole existing library the moment
    // someone pairs, so it starts its watermark at now and only reports what finishes
    // after that, the same way a new subscriber does not get every past post at once.
    const since = isFirstRun ? new Date().toISOString() : storedAt;
    const storedId = isFirstRun ? "" : await settingsService.get<string>(userId, "telegram.lastReportedId");
    if (isFirstRun) {
      await settingsService.setInternal(userId, "telegram.lastReportedAt", since);
      await settingsService.setInternal(userId, "telegram.lastReportedId", "");
    }

    const finished = await documentsRepository.listFinishedSince({ userId, source: "telegram", since, sinceId: storedId || undefined });
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
      // Persisted right after this one send, not once after the whole loop: if a later
      // send in this same batch throws, the watermark must already sit past every
      // document already announced, the same reasoning pollUpdatesOnce uses for its own
      // per-update cursor, or the next attempt announces them all over again.
      await settingsService.setInternal(userId, "telegram.lastReportedAt", document.createdAt);
      await settingsService.setInternal(userId, "telegram.lastReportedId", document.id);
    }
  }

  // Shared by pollUpdatesOnce and notifyOnce so each resolves the sole user and the
  // token independently: they run on separate clocks and neither may block on the
  // other to find out whether there is a bot to talk to.
  async function resolveClient(): Promise<{ userId: string; client: TelegramClient } | undefined> {
    const userId = await getUserId();
    if (!userId) return undefined;
    const token = await settingsService.get<string>(userId, "telegram.botToken");
    if (!token) return undefined;
    return { userId, client: clientFactory({ token }) };
  }

  // The long-polling half of the cycle. getUpdates can hold its connection open for up
  // to pollTimeoutSeconds, so nothing that needs to run sooner than that may live here.
  async function pollUpdatesOnce(): Promise<void> {
    const resolved = await resolveClient();
    if (!resolved) return;
    const { userId, client } = resolved;

    const lastUpdateId = (await settingsService.get<number>(userId, "telegram.lastUpdateId")) ?? 0;
    const updates = await client.getUpdates({ offset: lastUpdateId + 1, timeoutSeconds: pollTimeoutSeconds });

    for (const raw of updates) {
      const parsed = v.safeParse(telegramUpdateSchema, raw);
      const updateId = readUpdateId(raw);

      // A failing update gets a few immediate retries right here, in this same call,
      // since a blip such as one failed sendMessage often clears within a second or
      // two. If it is still failing after updateRetryAttempts, it is logged and skipped
      // rather than left to jam every update behind it: the cursor advances below
      // either way, so one message that always errors, or a user who blocked the bot,
      // costs at most this one message instead of stopping the loop for good.
      if (parsed.success) {
        let handled = false;
        let lastError: unknown;
        for (let attempt = 1; attempt <= updateRetryAttempts && !handled; attempt += 1) {
          try {
            await handleUpdate({ userId, client, update: parsed.output });
            handled = true;
          } catch (error) {
            lastError = error;
            if (attempt < updateRetryAttempts) await new Promise((resolve) => setTimeout(resolve, updateRetryDelayMs(attempt)));
          }
        }
        if (!handled) {
          logger.warn(
            { updateId, attempts: updateRetryAttempts, err: (lastError as Error)?.message ?? String(lastError) },
            "Telegram update failed on every retry, skipping it",
          );
        }
      }

      // The cursor advances here, after this update is either handled or given up on,
      // not once for the whole batch, so a later update never gets replayed on top of
      // work already done for an earlier one.
      if (updateId !== undefined) await settingsService.setInternal(userId, "telegram.lastUpdateId", updateId);
    }
  }

  // The finished-document half of the cycle, kept short on purpose so it never sits
  // behind a long poll. Only ever called from one place at a time, either here or from
  // the dedicated notify loop below, never both, so the lastReportedAt read-then-write
  // in reportFinishedDocuments never overlaps itself.
  async function notifyOnce(): Promise<void> {
    const resolved = await resolveClient();
    if (!resolved) return;
    await reportFinishedDocuments(resolved);
  }

  async function runOnce(): Promise<void> {
    await pollUpdatesOnce();
    await notifyOnce();
  }

  // One sequential loop per concern: each awaits its own action to finish before
  // sleeping and looping again, which is what keeps a slow or failing cycle from
  // overlapping with the next one of the same kind. The poll loop and the notify loop
  // never share a body, so a long getUpdates call can never delay a report.
  function runLoop({ action, idleMs, label }: { action: () => Promise<void>; idleMs: number; label: string }): Promise<void> {
    return (async () => {
      let attempt = 0;
      while (running) {
        try {
          await action();
          attempt = 0;
        } catch (error) {
          attempt += 1;
          logger.warn({ err: (error as Error).message, attempt, loop: label }, "Telegram loop cycle failed");
        }
        if (!running) break;
        const waitMs = attempt > 0 ? backoffDelayMs(attempt) : idleMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    })();
  }

  async function start() {
    // Telegram answers a second concurrent getUpdates for the same token with a 409,
    // so this guard is not optional: it is what keeps there being only one poller, and
    // it also keeps start() from ever spawning a second notify loop alongside it.
    if (running) return;
    running = true;
    pollLoop = runLoop({ action: pollUpdatesOnce, idleMs: idleIntervalMs, label: "poll" });
    notifyLoop = runLoop({ action: notifyOnce, idleMs: notifyIntervalMs, label: "notify" });
  }

  async function stop() {
    running = false;
    const timedOut = Symbol("telegram-shutdown-timeout");
    const outcome = await Promise.race([
      Promise.all([pollLoop, notifyLoop]).then(() => "stopped" as const),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), shutdownTimeoutMs)),
    ]);
    if (outcome === timedOut) {
      logger.warn({ shutdownTimeoutMs }, "Telegram loop still running past the shutdown deadline, no longer waiting on it");
    }
    pollLoop = null;
    notifyLoop = null;
  }

  return { runOnce, start, stop };
}

export type TelegramService = ReturnType<typeof createTelegramService>;
