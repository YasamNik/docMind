import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { createImapClient, type ImapClient } from "./email.client.js";
import { documentsFromMail } from "./email.models.js";

// Own loop in the shape telegram.usecases.ts established: re-reads its settings each
// cycle rather than reacting to a settings write, connects fresh every time rather
// than holding an IDLE connection open, and bounds every wait so one bad mailbox can
// never wedge the process. Unlike telegram, there is no cursor to advance: a handled
// message is moved out of the watched folder, which is what keeps it from being
// fetched again.

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MESSAGE_RETRY_ATTEMPTS = 3;
const DEFAULT_IDLE_INTERVAL_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export type EmailClientFactory = (config: { host: string; port: number; user: string; password: string }) => Promise<ImapClient>;

type ConnectionConfig = { host: string; port: number; user: string; password: string; folder: string; doneFolder: string; failedFolder: string };

function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 60000);
}

export function createEmailService({
  settingsService,
  documentsService,
  getUserId,
  clientFactory = createImapClient,
  logger = createLogger("email"),
  // How many messages one cycle takes from the watched folder. A mailbox pointed at
  // for the first time can hold thousands of messages; without this, the very first
  // cycle would try to read and file all of them before moving a single one, so a
  // crash partway through the first pass would leave nothing to show for it.
  batchSize = DEFAULT_BATCH_SIZE,
  // How many cycles a single message is allowed to fail in before it is moved to the
  // Failed folder instead of being retried again. Bounded so one message mailparser
  // or the storage path cannot make sense of never blocks the folder for good, the
  // same lesson the Telegram review found for a poisoned update.
  messageRetryAttempts = DEFAULT_MESSAGE_RETRY_ATTEMPTS,
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}: {
  settingsService: SettingsService;
  documentsService: DocumentsService;
  // There is exactly one account and this loop has no HTTP session to read it from,
  // so it resolves the sole signed-up user fresh every cycle, the same way it
  // re-reads the IMAP settings every cycle.
  getUserId: () => Promise<string | undefined>;
  clientFactory?: EmailClientFactory;
  logger?: Logger;
  batchSize?: number;
  messageRetryAttempts?: number;
  idleIntervalMs?: number;
  // How long stop() waits for the current cycle to finish before it gives up on the
  // wait. index.ts calls process.exit right after stop() regardless, so a cycle still
  // running past this deadline, for example one stuck on a server that accepted a
  // connection and never answered, costs nothing.
  shutdownTimeoutMs?: number;
}) {
  let running = false;
  let loop: Promise<void> | null = null;
  // How many times each message has failed so far, kept only for the life of this
  // process: a message that fails is retried on later cycles, and this is what
  // counts those cycles. Cleared the moment a message either succeeds or is moved to
  // Failed, so it never grows without bound.
  const messageAttempts = new Map<number, number>();

  async function resolveConnectionConfig(userId: string): Promise<ConnectionConfig | undefined> {
    const host = await settingsService.get<string>(userId, "email.imap.host");
    const password = await settingsService.get<string>(userId, "email.imap.password");
    if (!host || !password) return undefined;
    const port = (await settingsService.get<number>(userId, "email.imap.port")) ?? 993;
    const user = (await settingsService.get<string>(userId, "email.imap.user")) ?? "";
    const folder = (await settingsService.get<string>(userId, "email.imap.folder")) ?? "DocMind";
    const doneFolder = (await settingsService.get<string>(userId, "email.imap.doneFolder")) ?? "DocMind/Done";
    const failedFolder = (await settingsService.get<string>(userId, "email.imap.failedFolder")) ?? "DocMind/Failed";
    return { host, port, user, password, folder, doneFolder, failedFolder };
  }

  // Everything mailparser needs to know about one message, then the upload path takes
  // over. The connection stays open across this whole call: fetchMessage hands back a
  // stream from a live IMAP session, and simpleParser reads it end to end before this
  // function returns, so the connection this stream came from must not be closed
  // until well after that. Closing happens once, in runOnce, after every message in
  // the batch has gone through here.
  async function processMessage({ userId, client, folder, uid }: { userId: string; client: ImapClient; folder: string; uid: number }): Promise<void> {
    const fetched = await client.fetchMessage({ folder, uid });
    // keepCidLinks is not optional here: mailparser's default rewrites every cid:
    // reference in the html into a base64 data uri before documentsFromMail ever
    // sees it, which would make the inline-logo skip in that module unable to match
    // anything and turn every signature image into its own document.
    const parsed = await simpleParser(fetched.source, { keepCidLinks: true });
    const { mail, attachments } = documentsFromMail(parsed);

    const { document: mailDocument } = await documentsService.upload({
      userId,
      name: mail.name,
      mimeType: "text/plain",
      body: Readable.from([mail.text]),
      source: "email",
    });

    for (const attachment of attachments) {
      await documentsService.upload({
        userId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        body: Readable.from([attachment.content]),
        source: "email",
        parentDocumentId: mailDocument.id,
      });
    }
  }

  // One message's whole outcome for this cycle: process it, and either move it to
  // Done, count the failed attempt and leave it in place for the next cycle, or, once
  // messageRetryAttempts is used up, move it to Failed so it stops being retried and
  // stops sitting at the front of every future batch ahead of mail that would
  // otherwise go through cleanly.
  async function handleMessage({
    userId,
    client,
    folder,
    doneFolder,
    failedFolder,
    uid,
  }: {
    userId: string;
    client: ImapClient;
    folder: string;
    doneFolder: string;
    failedFolder: string;
    uid: number;
  }): Promise<void> {
    try {
      await processMessage({ userId, client, folder, uid });
      messageAttempts.delete(uid);
      await client.moveMessage({ folder, uid, destination: doneFolder });
    } catch (error) {
      const attempts = (messageAttempts.get(uid) ?? 0) + 1;
      const reason = (error as Error)?.message ?? String(error);
      if (attempts >= messageRetryAttempts) {
        messageAttempts.delete(uid);
        logger.warn({ uid, attempts, err: reason }, "Email message failed on every retry, moving it to Failed");
        await client.moveMessage({ folder, uid, destination: failedFolder });
      } else {
        messageAttempts.set(uid, attempts);
        logger.warn({ uid, attempts, err: reason }, "Email message failed, will retry on a later cycle");
      }
    }
  }

  async function runOnce(): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    const connection = await resolveConnectionConfig(userId);
    if (!connection) return;

    const { folder, doneFolder, failedFolder, ...credentials } = connection;
    const client = await clientFactory(credentials);
    try {
      await client.ensureFolder({ folder: doneFolder });
      await client.ensureFolder({ folder: failedFolder });

      const messages = await client.listFolder({ folder, limit: batchSize });
      for (const { uid } of messages) {
        await handleMessage({ userId, client, folder, doneFolder, failedFolder, uid });
      }
      await settingsService.setInternal(userId, "email.imap.lastError", "");
    } catch (error) {
      const reason = (error as Error)?.message ?? String(error);
      await settingsService.setInternal(userId, "email.imap.lastError", reason);
      throw error;
    } finally {
      await client.close();
    }
  }

  // One sequential loop: each cycle finishes before the next one starts, which is
  // what keeps a slow cycle from overlapping the next. A failure backs the whole loop
  // off rather than only that cycle, since a connection failure is far more likely to
  // still be true a second from now than a second later.
  function runLoop(): Promise<void> {
    return (async () => {
      let attempt = 0;
      while (running) {
        try {
          await runOnce();
          attempt = 0;
        } catch (error) {
          attempt += 1;
          logger.warn({ err: (error as Error)?.message ?? String(error), attempt }, "Email loop cycle failed");
        }
        if (!running) break;
        const waitMs = attempt > 0 ? backoffDelayMs(attempt) : idleIntervalMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    })();
  }

  async function start() {
    if (running) return;
    running = true;
    loop = runLoop();
  }

  async function stop() {
    running = false;
    const timedOut = Symbol("email-shutdown-timeout");
    const outcome = await Promise.race([
      (loop ?? Promise.resolve()).then(() => "stopped" as const),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), shutdownTimeoutMs)),
    ]);
    if (outcome === timedOut) {
      logger.warn({ shutdownTimeoutMs }, "Email loop still running past the shutdown deadline, no longer waiting on it");
    }
    loop = null;
  }

  return { runOnce, start, stop };
}

export type EmailService = ReturnType<typeof createEmailService>;
