import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { createError, isAppError } from "../../shared/errors/errors.js";
import {
  buildGoogleAuthorizeUrl,
  createGoogleAccessTokenProvider,
  exchangeGoogleAuthCode,
  verifyGoogleIdToken,
  type GoogleAccessTokenProvider,
} from "../../shared/google-oauth.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { signState, verifyState } from "../storage/storage.models.js";
import { createImapClient, type ImapClient } from "./email.client.js";
import { classifyEmailFailure, documentsFromMail, resolveEmailMode, type EmailMode } from "./email.models.js";

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
const BYTES_PER_MB = 1024 * 1024;
// The connection test cares about the true count waiting in the folder, not a
// processing-sized slice of it, so it asks listFolder for everything rather than the
// batchSize the loop itself uses.
const TEST_FOLDER_LIMIT = Number.MAX_SAFE_INTEGER;

// Gmail over OAuth. mail.google.com is the only IMAP scope Google offers; openid and
// the email scope exist only so the exchange returns an id token this module can read
// an address out of, which is what lets Connect Gmail ask for nothing but a click.
const GMAIL_OAUTH_PURPOSE = "email:gmail";
const GMAIL_SCOPES = ["https://mail.google.com/", "openid", "https://www.googleapis.com/auth/userinfo.email"];
// Facts, not settings: imap.gmail.com and 993 never change, and a field that can hold
// only one correct value is a field that can be typed wrong.
const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;

export type EmailClientFactory = (config: { host: string; port: number; user: string; password?: string; accessToken?: string }) => Promise<ImapClient>;
export type EmailTestResult = { ok: boolean; message: string };
export type GoogleAppCredentials = { clientId: string; clientSecret: string };
export type GoogleTokenProviderFactory = (args: { clientId: string; clientSecret: string; refreshToken: string }) => GoogleAccessTokenProvider;
export type EmailStatus = {
  mode: EmailMode;
  connectedAs?: string;
  googleAppAvailable: boolean;
  redirectUri: string;
  needsReconnect: boolean;
  lastError?: string;
};

type MailboxSettings = {
  folder: string;
  doneFolder: string;
  failedFolder: string;
  maxMessageSizeBytes: number;
};

function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 60000);
}

// A fetch or a move that failed because the connection itself dropped, read the same
// narrow way imapFailureReason reads it below: every failure email.client.ts's own
// calls produce is rebuilt into this one error code, so this is the one honest way to
// tell "the socket went away" apart from "mailparser or the upload path did not like
// this particular message". A plain Error, the kind a bad message actually throws, is
// never mistaken for this.
function isConnectionFailure(error: unknown): boolean {
  return isAppError(error) && error.code === "email.imap_error";
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// The reason a connect or a folder open failed, read only off email.client.ts's own
// rebuilt error, never off anything else. That client already guarantees its message
// carries no password; this only picks one of its short, fixed reasons back out so the
// test result can read differently for each cause, the way a person actually needs.
function imapFailureReason(error: unknown): string | undefined {
  if (!isAppError(error) || error.code !== "email.imap_error") return undefined;
  return error.message.split(": ").pop();
}

function testFailureMessage({ error, host, port, folder }: { error: unknown; host: string; port: number; folder: string }): string {
  switch (imapFailureReason(error)) {
    case "authentication failed":
      return "Sign-in failed. Check the mailbox address and password. Gmail and most providers need an app password, not your account password.";
    case "the folder does not exist":
      return `The folder "${folder}" does not exist. Create it in your mailbox first.`;
    case "could not resolve the host":
      return `Could not find a mail server at "${host}". Check the hostname.`;
    case "the connection was refused":
      return `"${host}:${port}" refused the connection. Check the host and port.`;
    case "timed out":
      return `Connecting to "${host}" timed out. Check the host, the port, and your network.`;
    default:
      return "Could not connect to the mailbox. Check the settings and try again.";
  }
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
  // Opaque to this module: produces the one redirect uri Google already has
  // registered, for storage's Google Drive connection, so Gmail never registers a
  // second one. Only buildGmailAuthorizeUrl and completeGmailConnection use it.
  buildRedirectUri,
  // Reads the Google app already saved for a driver's own connection, if any, so
  // Gmail can reuse it instead of asking for a second app registration. Returns
  // undefined when nothing is saved, the same outcome resolveGoogleApp gives when no
  // override is set either.
  getSharedGoogleApp,
  // Mints an access token from a Google refresh token. Defaults to the real
  // implementation; a test injects a fake here the same way it injects clientFactory,
  // so no test ever reaches Google. This module memoizes one provider per client id
  // and refresh token identity, below, so a test can also assert that memoization
  // rather than only the provider's own internal cache.
  createTokenProvider = createGoogleAccessTokenProvider,
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
  buildRedirectUri?: (args: { origin: string }) => string;
  getSharedGoogleApp?: (userId: string) => Promise<GoogleAppCredentials | undefined>;
  createTokenProvider?: GoogleTokenProviderFactory;
}) {
  let running = false;
  let loop: Promise<void> | null = null;
  // How many times each message has failed so far, kept only for the life of this
  // process: a message that fails is retried on later cycles, and this is what
  // counts those cycles. Cleared the moment a message either succeeds or is moved to
  // Failed, so it never grows without bound.
  const messageAttempts = new Map<number, number>();

  // The access token lasts about an hour and the loop connects every minute, so
  // minting one per cycle would be sixty pointless round trips an hour. This holds
  // one provider, which carries its own cached token, per client id and refresh
  // token identity: a cycle whose Gmail settings have not changed reuses the same
  // provider, and both the loop and testConnection call this same function, so
  // pressing Test repeatedly cannot hammer Google either.
  let gmailTokenProviderCache: { clientId: string; refreshToken: string; provider: GoogleAccessTokenProvider } | undefined;

  function gmailTokenProviderFor({ clientId, clientSecret, refreshToken }: { clientId: string; clientSecret: string; refreshToken: string }): GoogleAccessTokenProvider {
    if (gmailTokenProviderCache && gmailTokenProviderCache.clientId === clientId && gmailTokenProviderCache.refreshToken === refreshToken) {
      return gmailTokenProviderCache.provider;
    }
    const provider = createTokenProvider({ clientId, clientSecret, refreshToken });
    gmailTokenProviderCache = { clientId, refreshToken, provider };
    return provider;
  }

  async function resolveMode(userId: string): Promise<EmailMode> {
    const gmailRefreshToken = await settingsService.get<string>(userId, "email.gmail.refreshToken");
    const gmailAccountEmail = await settingsService.get<string>(userId, "email.gmail.accountEmail");
    const imapHost = await settingsService.get<string>(userId, "email.imap.host");
    const imapPassword = await settingsService.get<string>(userId, "email.imap.password");
    return resolveEmailMode({ gmailRefreshToken, gmailAccountEmail, imapHost, imapPassword });
  }

  async function resolveMailboxSettings(userId: string): Promise<MailboxSettings> {
    const folder = (await settingsService.get<string>(userId, "email.imap.folder")) ?? "DocMind";
    const doneFolder = (await settingsService.get<string>(userId, "email.imap.doneFolder")) ?? "DocMind/Done";
    const failedFolder = (await settingsService.get<string>(userId, "email.imap.failedFolder")) ?? "DocMind/Failed";
    const maxMessageSizeMb = (await settingsService.get<number>(userId, "email.imap.maxMessageSizeMb")) ?? 25;
    return { folder, doneFolder, failedFolder, maxMessageSizeBytes: maxMessageSizeMb * BYTES_PER_MB };
  }

  // The credentials for password mode, unchanged from what resolveConnectionConfig
  // used to read: host and password are required, port and user fall back to their
  // usual defaults.
  async function resolvePasswordCredentials(userId: string): Promise<{ host: string; port: number; user: string; password: string }> {
    const host = await settingsService.get<string>(userId, "email.imap.host");
    const password = await settingsService.get<string>(userId, "email.imap.password");
    if (!host || !password) {
      throw createError({ code: "email.imap_not_configured", message: "The mailbox host and app password are not both set.", status: 400 });
    }
    const port = (await settingsService.get<number>(userId, "email.imap.port")) ?? 993;
    const user = (await settingsService.get<string>(userId, "email.imap.user")) ?? "";
    return { host, port, user, password };
  }

  // The credentials for Gmail mode. Mints the access token here, before the caller
  // opens the IMAP connection, so a dead grant fails first and fast rather than after
  // a socket is already open.
  async function resolveGmailCredentials(userId: string): Promise<{ host: string; port: number; user: string; accessToken: string }> {
    const accountEmail = await settingsService.get<string>(userId, "email.gmail.accountEmail");
    const refreshToken = await settingsService.get<string>(userId, "email.gmail.refreshToken");
    if (!accountEmail || !refreshToken) {
      throw createError({ code: "email.gmail_not_configured", message: "Gmail is not fully connected. Connect it again.", status: 400 });
    }
    const app = await resolveGoogleApp(userId);
    if (!app) {
      throw createError({
        code: "email.gmail_not_configured",
        message: "Connect Google Drive first so Gmail can reuse its app, or set a Gmail-specific client id and secret, before connecting.",
        status: 400,
      });
    }
    const provider = gmailTokenProviderFor({ clientId: app.clientId, clientSecret: app.clientSecret, refreshToken });
    const accessToken = await provider.getAccessToken();
    return { host: GMAIL_IMAP_HOST, port: GMAIL_IMAP_PORT, user: accountEmail, accessToken };
  }

  // Persists the outcome of a cycle or a Test attempt through the one classifier both
  // paths share, so the reconnect banner and the button's own last word on the
  // connection can never disagree.
  async function clearEmailFailure(userId: string): Promise<void> {
    await settingsService.setInternal(userId, "email.imap.lastError", "");
    await settingsService.removeInternal(userId, "email.imap.lastErrorCode");
  }

  async function recordEmailFailure(userId: string, error: unknown): Promise<void> {
    const classified = classifyEmailFailure(error);
    await settingsService.setInternal(userId, "email.imap.lastError", classified.message);
    await settingsService.setInternal(userId, "email.imap.lastErrorCode", classified.code);
  }

  // Everything mailparser needs to know about one message, then the upload path takes
  // over. The connection stays open across this whole call: fetchMessage hands back a
  // stream from a live IMAP session, and simpleParser reads it end to end before this
  // function returns, so the connection this stream came from must not be closed
  // until well after that. Closing happens once, in runOnce, after every message in
  // the batch has gone through here.
  async function processMessage({
    userId,
    client,
    folder,
    uid,
    maxMessageSizeBytes,
  }: {
    userId: string;
    client: ImapClient;
    folder: string;
    uid: number;
    maxMessageSizeBytes: number;
  }): Promise<void> {
    // Checked against what IMAP itself reports for the message, before any of it is
    // downloaded. mailparser reads a whole message into memory before the upload path
    // sees any of it, so this is the one place peak memory per message can actually be
    // bounded; the upload path's own size cap runs too late to help here. A server
    // that does not answer with a size leaves this unable to judge the message at
    // all, so it lets it through rather than failing every message a server like that
    // sends.
    const size = await client.messageSize({ folder, uid });
    if (typeof size === "number" && size > maxMessageSizeBytes) {
      throw createError({
        code: "email.message_too_large",
        message: `Message is ${size} bytes, over the ${maxMessageSizeBytes} byte limit, and was not downloaded`,
        status: 413,
      });
    }

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
  //
  // That bad-message retry accounting only applies to a failure this message actually
  // caused. A fetch or a move that failed because the connection itself dropped is not
  // evidence against this uid, and every message behind it in the same batch would
  // fail the exact same way for the exact same reason. Such a failure is rethrown
  // untouched: it skips the retry count entirely and reaches runOnce's own catch,
  // which abandons the rest of the batch and backs the whole cycle off, rather than
  // one connection blip slowly walking a folder of good, unread mail into Failed.
  async function handleMessage({
    userId,
    client,
    folder,
    doneFolder,
    failedFolder,
    maxMessageSizeBytes,
    uid,
  }: {
    userId: string;
    client: ImapClient;
    folder: string;
    doneFolder: string;
    failedFolder: string;
    maxMessageSizeBytes: number;
    uid: number;
  }): Promise<void> {
    try {
      await processMessage({ userId, client, folder, uid, maxMessageSizeBytes });
      messageAttempts.delete(uid);
      await client.moveMessage({ folder, uid, destination: doneFolder });
    } catch (error) {
      if (isConnectionFailure(error)) throw error;

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

  // How long the loop waits between one cycle finishing and the next starting, absent
  // a failure. Starts at the constructor default, which only ever governs a cycle
  // before any user has been resolved; from the first cycle that reaches a real user
  // onward, it tracks that user's own email.imap.pollSeconds, re-read every cycle the
  // same way the credentials themselves are, so saving a new value takes effect on the
  // very next wait rather than needing a restart.
  let idleWaitMs = idleIntervalMs;

  async function runOnce(): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    const pollSeconds = await settingsService.get<number>(userId, "email.imap.pollSeconds");
    if (typeof pollSeconds === "number" && pollSeconds > 0) idleWaitMs = pollSeconds * 1000;

    // Declared outside the try so the finally block below can tell "the client was
    // never created" apart from "the client was created and something after it
    // failed", and only close a connection that actually exists.
    let client: ImapClient | undefined;
    try {
      const mode = await resolveMode(userId);
      if (mode === "unconfigured") return;

      const mailbox = await resolveMailboxSettings(userId);
      // Minted before the client factory ever opens a socket, so a dead Gmail grant
      // fails here, fast, rather than after a connection is already open.
      const credentials = mode === "gmail" ? await resolveGmailCredentials(userId) : await resolvePasswordCredentials(userId);

      client = await clientFactory(credentials);
      await client.ensureFolder({ folder: mailbox.doneFolder });
      await client.ensureFolder({ folder: mailbox.failedFolder });

      const messages = await client.listFolder({ folder: mailbox.folder, limit: batchSize });
      for (const { uid } of messages) {
        await handleMessage({
          userId,
          client,
          folder: mailbox.folder,
          doneFolder: mailbox.doneFolder,
          failedFolder: mailbox.failedFolder,
          maxMessageSizeBytes: mailbox.maxMessageSizeBytes,
          uid,
        });
      }
      await clearEmailFailure(userId);
    } catch (error) {
      // email.imap.lastError and email.imap.lastErrorCode are plain, non-secret
      // settings rows meant for a person and the reconnect banner to read, not a log.
      // classifyEmailFailure reads only structured fields off an AppError, imap or
      // Google, never an underlying message that could carry a password or a token.
      await recordEmailFailure(userId, error);
      throw error;
    } finally {
      if (client) await client.close();
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
          // The server log is the diagnosis surface and is never returned by the API,
          // so the full underlying message goes here on purpose, unlike the short,
          // curated reason runOnce persists to email.imap.lastError above: change 1
          // already closes the one path by which a password could reach this far.
          logger.warn({ err: (error as Error)?.message ?? String(error), attempt }, "Email loop cycle failed");
        }
        if (!running) break;
        const waitMs = attempt > 0 ? backoffDelayMs(attempt) : idleWaitMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    })();
  }

  async function start() {
    if (running) return;
    running = true;
    loop = runLoop();
  }

  // Gmail's own Test path. Mints a token through the same memoized provider the loop
  // uses, connects, and reports what it finds. Unlike the password path's wording,
  // an authentication failure here must never suggest an app password: that is a
  // password-mode fix and is wrong advice for an account that connected through
  // Google.
  async function testGmailConnection(userId: string): Promise<EmailTestResult> {
    const folder = (await settingsService.get<string>(userId, "email.imap.folder")) ?? "DocMind";
    let client: ImapClient | undefined;
    try {
      const credentials = await resolveGmailCredentials(userId);
      client = await clientFactory(credentials);
      const messages = await client.listFolder({ folder, limit: TEST_FOLDER_LIMIT });
      const count = messages.length;
      await clearEmailFailure(userId);
      return { ok: true, message: `Connected to Gmail as ${credentials.user}. ${count} message${count === 1 ? "" : "s"} waiting.` };
    } catch (error) {
      await recordEmailFailure(userId, error);
      if (isAppError(error) && error.code === "google.reauth_required") {
        return { ok: false, message: "Gmail access has expired or been revoked. Press Reconnect." };
      }
      if (isAppError(error) && error.code === "google.auth_failed") {
        return { ok: false, message: "Could not sign in to Gmail. Try again in a moment." };
      }
      if (imapFailureReason(error) === "authentication failed") {
        return {
          ok: false,
          message: "Google accepted the account but Gmail refused the connection. If this is a Workspace account, check that your administrator allows IMAP.",
        };
      }
      return { ok: false, message: testFailureMessage({ error, host: GMAIL_IMAP_HOST, port: GMAIL_IMAP_PORT, folder }) };
    } finally {
      if (client) await client.close();
    }
  }

  // What the settings page's Test button calls. Unlike runOnce, this speaks for a
  // signed-in request rather than the loop's own resolved user, so the caller supplies
  // userId directly instead of going through getUserId. It never moves a message and
  // never uploads anything: it only proves the credentials sign in and the watched
  // folder opens, and says how many messages are sitting there. Writes lastError and
  // lastErrorCode through the same classifier runOnce uses, so the reconnect banner
  // reflects whatever this button just said immediately, not on the loop's own
  // schedule.
  async function testConnection({ userId }: { userId: string }): Promise<EmailTestResult> {
    const mode = await resolveMode(userId);
    if (mode === "gmail") return testGmailConnection(userId);

    const host = await settingsService.get<string>(userId, "email.imap.host");
    const user = await settingsService.get<string>(userId, "email.imap.user");
    const password = await settingsService.get<string>(userId, "email.imap.password");
    const port = (await settingsService.get<number>(userId, "email.imap.port")) ?? 993;
    const folder = (await settingsService.get<string>(userId, "email.imap.folder")) ?? "DocMind";

    if (!host || !user || !password) {
      const missing: string[] = [];
      if (!host) missing.push("host");
      if (!user) missing.push("mailbox address");
      if (!password) missing.push("app password");
      return { ok: false, message: `Set ${joinWithAnd(missing)} before testing the connection.` };
    }

    let client: ImapClient | undefined;
    try {
      client = await clientFactory({ host, port, user, password });
      const messages = await client.listFolder({ folder, limit: TEST_FOLDER_LIMIT });
      const count = messages.length;
      await clearEmailFailure(userId);
      return { ok: true, message: `Connected. ${count} message${count === 1 ? "" : "s"} waiting.` };
    } catch (error) {
      await recordEmailFailure(userId, error);
      return { ok: false, message: testFailureMessage({ error, host, port, folder }) };
    } finally {
      if (client) await client.close();
    }
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

  // The Google app Gmail connects with: an override saved on this page if one is set,
  // otherwise the app already saved for storage's Google Drive connection, otherwise
  // nothing. The override is all or nothing, since pairing one app's id with another
  // app's secret only fails once Google rejects the request, in a way nobody can read.
  async function resolveGoogleApp(userId: string): Promise<GoogleAppCredentials | undefined> {
    const overrideClientId = await settingsService.get<string>(userId, "email.gmail.clientId");
    const overrideClientSecret = await settingsService.get<string>(userId, "email.gmail.clientSecret");
    if (overrideClientId || overrideClientSecret) {
      if (!overrideClientId || !overrideClientSecret) {
        throw createError({
          code: "email.gmail_app_incomplete",
          message: "Set both a client id and a client secret to use a Gmail-specific Google app, or clear both to use the app already saved for Google Drive.",
          status: 400,
        });
      }
      return { clientId: overrideClientId, clientSecret: overrideClientSecret };
    }
    return getSharedGoogleApp ? getSharedGoogleApp(userId) : undefined;
  }

  function redirectUriFor(origin: string): string {
    if (!buildRedirectUri) {
      throw new Error("createEmailService was not given buildRedirectUri");
    }
    return buildRedirectUri({ origin });
  }

  // What GET /api/email/gmail/connect redirects the browser to. The state carries the
  // user's identity and a purpose only this module recognizes, because the callback
  // that follows arrives on storage's shared redirect address with no session of its
  // own.
  async function buildGmailAuthorizeUrl({ userId, origin, secretHex }: { userId: string; origin: string; secretHex: string }): Promise<string> {
    const app = await resolveGoogleApp(userId);
    if (!app) {
      throw createError({
        code: "email.gmail_not_configured",
        message: "Connect Google Drive first so Gmail can reuse its app, or set a Gmail-specific client id and secret, before connecting.",
        status: 400,
      });
    }
    const state = signState({ userId, purpose: GMAIL_OAUTH_PURPOSE, secretHex });
    return buildGoogleAuthorizeUrl({ clientId: app.clientId, redirectUri: redirectUriFor(origin), scopes: GMAIL_SCOPES, state });
  }

  // The completer storage's callback route hands a Gmail state to. Verifies the state
  // again for itself, exactly as storage's own completion does for a storage purpose,
  // so nothing the route decided can weaken what this module checks.
  async function completeGmailConnection({
    code,
    state,
    origin,
    secretHex,
  }: {
    code: string;
    state: string;
    origin: string;
    secretHex: string;
  }): Promise<{ redirectTo: string }> {
    const verified = verifyState({ state, secretHex });
    if (verified.purpose !== GMAIL_OAUTH_PURPOSE) {
      throw createError({ code: "email.invalid_state", message: "Invalid oauth state", status: 400 });
    }
    const userId = verified.userId;

    const app = await resolveGoogleApp(userId);
    if (!app) {
      throw createError({
        code: "email.gmail_not_configured",
        message: "Connect Google Drive first so Gmail can reuse its app, or set a Gmail-specific client id and secret, before connecting.",
        status: 400,
      });
    }

    const exchange = await exchangeGoogleAuthCode({
      code,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      redirectUri: redirectUriFor(origin),
    });
    if (!exchange.idToken) {
      throw createError({
        code: "email.gmail_no_identity",
        message: "Google did not return an account address for this connection.",
        status: 400,
      });
    }
    const identity = await verifyGoogleIdToken({ idToken: exchange.idToken, clientId: app.clientId });

    await settingsService.set(userId, {
      "email.gmail.refreshToken": exchange.refreshToken,
      "email.gmail.accountEmail": identity.email,
    });

    return { redirectTo: "/settings?tab=email&connected=gmail" };
  }

  // What the Email tab reads to render itself: the resolved mode, who is connected,
  // whether a Google app exists to reuse, the address to register if not, and whether
  // the last cycle or Test needs a reconnect. Never a secret, a password or a token:
  // googleAppAvailable is a plain boolean, never the client id or secret it is
  // computed from.
  async function getStatus({ userId, origin }: { userId: string; origin: string }): Promise<EmailStatus> {
    const mode = await resolveMode(userId);
    const lastErrorCode = await settingsService.get<string>(userId, "email.imap.lastErrorCode");
    const lastError = await settingsService.get<string>(userId, "email.imap.lastError");

    let connectedAs: string | undefined;
    if (mode === "gmail") {
      connectedAs = await settingsService.get<string>(userId, "email.gmail.accountEmail");
    } else if (mode === "password") {
      connectedAs = await settingsService.get<string>(userId, "email.imap.user");
    }

    // A half set client id and secret override throws from resolveGoogleApp; the
    // status page only needs to know a usable app is not currently available, not
    // reject the whole request over it.
    const googleApp = await resolveGoogleApp(userId).catch(() => undefined);

    return {
      mode,
      connectedAs: connectedAs || undefined,
      googleAppAvailable: Boolean(googleApp),
      redirectUri: redirectUriFor(origin),
      needsReconnect: lastErrorCode === "reauth_required",
      lastError: lastError || undefined,
    };
  }

  return { runOnce, start, stop, testConnection, buildGmailAuthorizeUrl, completeGmailConnection, getStatus };
}

export type EmailService = ReturnType<typeof createEmailService>;
