import type { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import { createError } from "../../shared/errors/errors.js";

// imapflow wrapped in the shape telegram.client.ts established: a handful of named
// calls the loop actually needs rather than the library's own surface, so a fake in
// a test is a few lines instead of an imapflow emulator.

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type ImapMessageSummary = { uid: number };
export type ImapFetchedMessage = { uid: number; source: Readable };

// The narrow slice of imapflow this client depends on. Every call a test fake has to
// implement is listed here, nothing else: no event emitter, no locks, no idle.
export type ImapConnection = {
  connect(): Promise<void>;
  list(): Promise<{ path: string }[]>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxOpen(path: string): Promise<unknown>;
  search(query: { all: boolean }, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
  download(range: number, part?: string, options?: { uid?: boolean }): Promise<{ content: Readable }>;
  messageMove(range: number, destination: string, options?: { uid?: boolean }): Promise<unknown>;
  logout(): Promise<void>;
  close(): void;
};

type ImapConnectOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  // Disabled outright rather than pointed at DocMind's own logger: imapflow's default
  // logger otherwise writes protocol traffic on its own, and the one command that
  // opens this connection carries the password.
  logger: false;
};

export type ImapConnectionFactory = (options: ImapConnectOptions) => ImapConnection;

const defaultConnectionFactory: ImapConnectionFactory = (options) => new ImapFlow(options);

// Built from the operation and a short, curated reason only, never from the
// underlying error's own message, response text or executed command. imapflow
// echoes the failing command on some errors, and the command that authenticates
// carries the password, so forwarding any part of the library's own error risks
// putting it in a log line, a thrown stack, or an API response. Only a few known,
// safe, structured fields are read here, never free text.
function reasonFor(error: unknown): string {
  if (error && typeof error === "object") {
    const details = error as { authenticationFailed?: boolean; mailboxMissing?: boolean; code?: string };
    if (details.authenticationFailed) return "authentication failed";
    if (details.mailboxMissing) return "the folder does not exist";
    if (details.code === "ENOTFOUND" || details.code === "EAI_AGAIN") return "could not resolve the host";
    if (details.code === "ECONNREFUSED") return "the connection was refused";
    if (details.code === "ETIMEDOUT") return "timed out";
  }
  return "failed";
}

function imapError({ operation, host, reason }: { operation: string; host: string; reason: string }) {
  return createError({
    code: "email.imap_error",
    message: `IMAP ${operation} to ${host}: ${reason}`,
    status: 502,
  });
}

// Every command gets its own local deadline. imapflow's own connectionTimeout and
// socketTimeout bound the socket, but a server that accepts a connection and then
// never answers a command can still leave a call pending past those, the same class
// of bug the Telegram review found in a getUpdates call whose own timeout parameter
// bounded nothing on this end. This wrapper bounds the wait regardless of what the
// underlying library does, win or lose the race.
function withTimeout<T>(promise: Promise<T>, { timeoutMs, operation, host }: { timeoutMs: number; operation: string; host: string }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(imapError({ operation, host, reason: "timed out" })), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(imapError({ operation, host, reason: reasonFor(error) }));
      },
    );
  });
}

export async function createImapClient({
  host,
  port,
  user,
  password,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  connectionFactory = defaultConnectionFactory,
}: {
  host: string;
  port: number;
  user: string;
  password: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  connectionFactory?: ImapConnectionFactory;
}) {
  const connection = connectionFactory({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    connectionTimeout: connectTimeoutMs,
    greetingTimeout: connectTimeoutMs,
    socketTimeout: commandTimeoutMs,
    logger: false,
  });

  try {
    await withTimeout(connection.connect(), { timeoutMs: connectTimeoutMs, operation: "connect", host });
  } catch (error) {
    // Nobody outside this function holds a reference to connection yet, so a failed
    // or timed out connect attempt would otherwise leak whatever the socket got up
    // to before it. Force it closed before the caller ever sees the error.
    connection.close();
    throw error;
  }

  async function listFolder({ folder, limit }: { folder: string; limit: number }): Promise<ImapMessageSummary[]> {
    await withTimeout(connection.mailboxOpen(folder), { timeoutMs: commandTimeoutMs, operation: "mailboxOpen", host });
    const uids = await withTimeout(connection.search({ all: true }, { uid: true }), { timeoutMs: commandTimeoutMs, operation: "search", host });
    return (uids || []).slice(0, limit).map((uid) => ({ uid }));
  }

  async function fetchMessage({ folder, uid }: { folder: string; uid: number }): Promise<ImapFetchedMessage> {
    await withTimeout(connection.mailboxOpen(folder), { timeoutMs: commandTimeoutMs, operation: "mailboxOpen", host });
    const downloaded = await withTimeout(connection.download(uid, undefined, { uid: true }), {
      timeoutMs: commandTimeoutMs,
      operation: "download",
      host,
    });
    return { uid, source: downloaded.content };
  }

  async function moveMessage({ folder, uid, destination }: { folder: string; uid: number; destination: string }): Promise<void> {
    await withTimeout(connection.mailboxOpen(folder), { timeoutMs: commandTimeoutMs, operation: "mailboxOpen", host });
    await withTimeout(connection.messageMove(uid, destination, { uid: true }), {
      timeoutMs: commandTimeoutMs,
      operation: "messageMove",
      host,
    });
  }

  async function ensureFolder({ folder }: { folder: string }): Promise<void> {
    const existing = await withTimeout(connection.list(), { timeoutMs: commandTimeoutMs, operation: "list", host });
    if (existing.some((mailbox) => mailbox.path === folder)) return;
    await withTimeout(connection.mailboxCreate(folder), { timeoutMs: commandTimeoutMs, operation: "mailboxCreate", host });
  }

  async function close(): Promise<void> {
    try {
      await withTimeout(connection.logout(), { timeoutMs: commandTimeoutMs, operation: "logout", host });
    } catch {
      // A failed or timed out logout still leaves the socket open. Force it shut
      // either way in the finally block below: a stuck logout must never keep a
      // connection, and by extension a whole cycle, from ending.
    } finally {
      connection.close();
    }
  }

  return { listFolder, fetchMessage, moveMessage, ensureFolder, close };
}

export type ImapClient = Awaited<ReturnType<typeof createImapClient>>;
