import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createImapClient, type ImapConnection, type ImapConnectionFactory } from "./email.client.js";

const HOST = "imap.example.com";

function createFakeConnection(overrides: Partial<ImapConnection> = {}): ImapConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    mailboxCreate: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    fetchOne: vi.fn().mockResolvedValue({ size: 123 }),
    download: vi.fn().mockResolvedValue({ content: Readable.from(["body"]) }),
    messageMove: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...overrides,
  };
}

// Fakes throughout: a real socket is never opened in this file, per the plan's
// global constraint that no test may reach the network. Each fake implements only
// the six calls ImapConnection declares, which is the point of keeping that type
// narrow in the first place.
describe("createImapClient", () => {
  it("connects with the given host, port and credentials", async () => {
    const connection = createFakeConnection();
    const connectionFactory: ImapConnectionFactory = vi.fn().mockReturnValue(connection);

    await createImapClient({ host: HOST, port: 993, user: "me@example.com", password: "app-pw", connectionFactory });

    expect(connectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ host: HOST, port: 993, auth: { user: "me@example.com", pass: "app-pw" } }),
    );
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps the password out of a connection failure's error, but keeps the host and the reason", async () => {
    const password = "correct-horse-battery-staple";
    const connection = createFakeConnection({
      connect: vi.fn().mockRejectedValue(
        Object.assign(new Error(`Authentication failed for user "me@example.com" with password "${password}"`), {
          authenticationFailed: true,
        }),
      ),
    });

    const attempt = createImapClient({ host: HOST, port: 993, user: "me@example.com", password, connectionFactory: () => connection });

    await expectAppError(() => attempt, "email.imap_error");
    await attempt.catch((error: Error) => {
      expect(error.message).toContain(HOST);
      expect(error.message).toMatch(/authentication failed/i);
      expect(error.message).not.toContain(password);
      expect(error.stack ?? "").not.toContain(password);
    });
  });

  it("keeps the password out of a synchronous throw from the connection factory itself", async () => {
    const password = "correct-horse-battery-staple";
    const connectionFactory: ImapConnectionFactory = () => {
      throw new Error(`could not construct client for "me@example.com" with password "${password}"`);
    };

    const attempt = createImapClient({ host: HOST, port: 993, user: "me@example.com", password, connectionFactory });

    await expectAppError(() => attempt, "email.imap_error");
    await attempt.catch((error: Error) => {
      expect(error.message).toBe(`IMAP connect to ${HOST}: failed`);
      expect(error.message).not.toContain(password);
      expect(error.stack ?? "").not.toContain(password);
    });
  });

  it("force closes the connection if connecting fails, so a failed attempt leaks no socket", async () => {
    const connection = createFakeConnection({ connect: vi.fn().mockRejectedValue(new Error("nope")) });

    await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection }).catch(() => {});

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("gives up on a connect that never resolves, rather than hanging forever", async () => {
    const connection = createFakeConnection({ connect: () => new Promise(() => {}) });

    await expectAppError(
      () => createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectTimeoutMs: 20, connectionFactory: () => connection }),
      "email.imap_error",
    );
  });

  it("lists a bounded batch of uids from the watched folder", async () => {
    const connection = createFakeConnection({ search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5]) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    const messages = await client.listFolder({ folder: "DocMind", limit: 3 });

    expect(connection.mailboxOpen).toHaveBeenCalledWith("DocMind");
    expect(messages).toEqual([{ uid: 1 }, { uid: 2 }, { uid: 3 }]);
  });

  it("reads a message's size without downloading it", async () => {
    const connection = createFakeConnection({ fetchOne: vi.fn().mockResolvedValue({ size: 4096 }) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    const size = await client.messageSize({ folder: "DocMind", uid: 9 });

    expect(connection.mailboxOpen).toHaveBeenCalledWith("DocMind");
    expect(connection.fetchOne).toHaveBeenCalledWith(9, { size: true }, { uid: true });
    expect(connection.download).not.toHaveBeenCalled();
    expect(size).toBe(4096);
  });

  it("reports an unknown size as undefined rather than guessing", async () => {
    const connection = createFakeConnection({ fetchOne: vi.fn().mockResolvedValue(false) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    const size = await client.messageSize({ folder: "DocMind", uid: 9 });

    expect(size).toBeUndefined();
  });

  it("fetches a message as a stream without buffering it", async () => {
    const source = Readable.from(["raw mime"]);
    const connection = createFakeConnection({ download: vi.fn().mockResolvedValue({ content: source }) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    const message = await client.fetchMessage({ folder: "DocMind", uid: 42 });

    expect(connection.download).toHaveBeenCalledWith(42, undefined, { uid: true });
    expect(message.uid).toBe(42);
    expect(message.source).toBe(source);
  });

  it("moves a message to another folder", async () => {
    const connection = createFakeConnection();
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    await client.moveMessage({ folder: "DocMind", uid: 7, destination: "DocMind/Done" });

    expect(connection.mailboxOpen).toHaveBeenCalledWith("DocMind");
    expect(connection.messageMove).toHaveBeenCalledWith(7, "DocMind/Done", { uid: true });
  });

  it("creates a folder only when it does not already exist", async () => {
    const connection = createFakeConnection({ list: vi.fn().mockResolvedValue([{ path: "DocMind/Done" }]) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    await client.ensureFolder({ folder: "DocMind/Done" });

    expect(connection.mailboxCreate).not.toHaveBeenCalled();
  });

  it("creates a missing folder", async () => {
    const connection = createFakeConnection({ list: vi.fn().mockResolvedValue([]) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    await client.ensureFolder({ folder: "DocMind/Failed" });

    expect(connection.mailboxCreate).toHaveBeenCalledWith("DocMind/Failed");
  });

  it("logs out gracefully on close, then forces the connection closed either way", async () => {
    const connection = createFakeConnection();
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    await client.close();

    expect(connection.logout).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("still forces the connection closed if logout fails", async () => {
    const connection = createFakeConnection({ logout: vi.fn().mockRejectedValue(new Error("nope")) });
    const client = await createImapClient({ host: HOST, port: 993, user: "u", password: "p", connectionFactory: () => connection });

    await client.close();

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("gives every command its own deadline, not just connect", async () => {
    const connection = createFakeConnection({ mailboxOpen: () => new Promise(() => {}) });
    const client = await createImapClient({
      host: HOST,
      port: 993,
      user: "u",
      password: "p",
      commandTimeoutMs: 20,
      connectionFactory: () => connection,
    });

    await expectAppError(() => client.listFolder({ folder: "DocMind", limit: 10 }), "email.imap_error");
  });
});
