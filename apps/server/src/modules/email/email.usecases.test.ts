import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createError } from "../../shared/errors/errors.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createDocumentsService } from "../documents/documents.usecases.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import type { ImapClient } from "./email.client.js";
import { emailSettingDefinitions } from "./email.settings.js";
import { createEmailService, type EmailClientFactory } from "./email.usecases.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "fixtures");

async function fixtureBuffer(name: string): Promise<Buffer> {
  return readFile(join(FIXTURES_DIR, name));
}

// A watched mailbox in memory: folder name to the messages sitting in it, in the
// shape createImapClient's own narrow interface expects. Every test below drives
// this instead of a real socket, per the plan's global constraint that no test may
// open a network connection or need a mailbox.
function createFakeMailbox({ raw = {} }: { raw?: Record<number, Buffer> } = {}) {
  const folders = new Map<string, number[]>();
  const ensuredFolders: string[] = [];
  const fetchedUids: number[] = [];
  const movedMessages: { uid: number; from: string; destination: string }[] = [];
  let closed = false;
  let fetchOverride: ((uid: number) => Promise<{ uid: number; source: Readable }>) | undefined;
  let sizeOverride: ((uid: number) => Promise<number | undefined>) | undefined;
  // Fails the next call to moveMessage only, then returns to moving messages normally,
  // so a test can put a single connection blip right after processMessage has already
  // committed a message's documents without losing the fake's own default move logic.
  let failNextMoveOnce = false;

  function messagesIn(folder: string): number[] {
    return folders.get(folder) ?? [];
  }

  function seed(folder: string, uids: number[]) {
    folders.set(folder, [...uids]);
  }

  const client: ImapClient = {
    async listFolder({ folder, limit }) {
      return messagesIn(folder)
        .slice(0, limit)
        .map((uid) => ({ uid }));
    },
    async messageSize({ uid }) {
      if (sizeOverride) return sizeOverride(uid);
      return raw[uid]?.length;
    },
    async fetchMessage({ uid }) {
      fetchedUids.push(uid);
      if (fetchOverride) return fetchOverride(uid);
      const content = raw[uid];
      if (!content) throw new Error(`no fixture registered for uid ${uid}`);
      // A real Readable, not Readable.from on a pre-read buffer, so a bug that reads
      // the stream too late (after the connection thinks it is done) has something
      // to fail against.
      const source = new Readable({
        read() {
          this.push(content);
          this.push(null);
        },
      });
      return { uid, source };
    },
    async moveMessage({ folder, uid, destination }) {
      if (failNextMoveOnce) {
        failNextMoveOnce = false;
        throw createError({ code: "email.imap_error", message: "IMAP messageMove to imap.example.com: the connection was refused", status: 502 });
      }
      const current = messagesIn(folder);
      const index = current.indexOf(uid);
      if (index === -1) throw new Error(`uid ${uid} is not in ${folder}`);
      current.splice(index, 1);
      folders.set(folder, current);
      folders.set(destination, [...messagesIn(destination), uid]);
      movedMessages.push({ uid, from: folder, destination });
    },
    async ensureFolder({ folder }) {
      ensuredFolders.push(folder);
      if (!folders.has(folder)) folders.set(folder, []);
    },
    async close() {
      closed = true;
    },
  };

  return {
    client,
    seed,
    messagesIn,
    ensuredFolders,
    fetchedUids,
    movedMessages,
    isClosed: () => closed,
    setFetchOverride: (fn: typeof fetchOverride) => {
      fetchOverride = fn;
    },
    setSizeOverride: (fn: typeof sizeOverride) => {
      sizeOverride = fn;
    },
    failNextMove: () => {
      failNextMoveOnce = true;
    },
  };
}

const userId = "user-1";

let root: string;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
let settingsService: ReturnType<typeof createSettingsService>;
let documentsService: ReturnType<typeof createDocumentsService>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-email-"));
  ({ db } = await createTestDatabase());
  settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry([...storageSettingDefinitions, ...emailSettingDefinitions]),
    config: { settingsEncryptionKey: "33".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  const storageService = createStorageService({ settingsService, countDocuments: async () => 0 });
  documentsService = createDocumentsService({ db, storageService });
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function configureImap(overrides: Record<string, unknown> = {}) {
  await settingsService.set(userId, {
    "email.imap.host": "imap.example.com",
    "email.imap.user": "me@example.com",
    "email.imap.password": "an-app-password",
    ...overrides,
  });
}

function buildService(clientFactory: EmailClientFactory, overrides: Partial<Parameters<typeof createEmailService>[0]> = {}) {
  return createEmailService({
    settingsService,
    documentsService,
    getUserId: async () => userId,
    clientFactory,
    ...overrides,
  });
}

describe("email service", () => {
  it("does nothing while no host or password is configured", async () => {
    let called = false;
    const email = buildService(async () => {
      called = true;
      throw new Error("should not be called");
    });

    await expect(email.runOnce()).resolves.toBeUndefined();

    expect(called).toBe(false);
  });

  it("turns a mail and its attachment into two linked documents", async () => {
    await configureImap();
    const raw = await fixtureBuffer("attachment-with-note.eml");
    const mailbox = createFakeMailbox({ raw: { 1: raw } });
    mailbox.seed("DocMind", [1]);
    const email = buildService(async () => mailbox.client);

    await email.runOnce();

    const docs = await documentsService.list({ userId });
    const mail = docs.find((d) => d.name === "Invoice for March.txt");
    const attachment = docs.find((d) => d.name === "invoice.pdf");
    expect(mail).toBeDefined();
    expect(attachment).toBeDefined();
    const enrichedAttachment = await documentsService.get({ userId, documentId: attachment!.id });
    expect(enrichedAttachment.parentDocumentId).toBe(mail!.id);
    expect(enrichedAttachment.source).toBe("email");
  });

  it("moves a handled message to the Done folder", async () => {
    await configureImap();
    const raw = await fixtureBuffer("plain-text-only.eml");
    const mailbox = createFakeMailbox({ raw: { 1: raw } });
    mailbox.seed("DocMind", [1]);
    const email = buildService(async () => mailbox.client);

    await email.runOnce();

    expect(mailbox.messagesIn("DocMind")).toHaveLength(0);
    expect(mailbox.messagesIn("DocMind/Done")).toEqual([1]);
  });

  it("does not handle the same message twice", async () => {
    await configureImap();
    const raw = await fixtureBuffer("plain-text-only.eml");
    const mailbox = createFakeMailbox({ raw: { 1: raw } });
    mailbox.seed("DocMind", [1]);
    const email = buildService(async () => mailbox.client);

    await email.runOnce();
    await email.runOnce();

    expect(mailbox.fetchedUids).toEqual([1]);
    expect(await documentsService.list({ userId })).toHaveLength(1);
  });

  it("creates the Done and Failed folders when they do not exist", async () => {
    await configureImap();
    const mailbox = createFakeMailbox();
    const email = buildService(async () => mailbox.client);

    await email.runOnce();

    expect(mailbox.ensuredFolders).toContain("DocMind/Done");
    expect(mailbox.ensuredFolders).toContain("DocMind/Failed");
  });

  it("moves an oversized message to Failed without ever downloading it", async () => {
    await configureImap({ "email.imap.maxMessageSizeMb": 1 });
    const mailbox = createFakeMailbox();
    mailbox.seed("DocMind", [1]);
    mailbox.setSizeOverride(async () => 2 * 1024 * 1024);
    const email = buildService(async () => mailbox.client, { messageRetryAttempts: 1 });

    await email.runOnce();

    expect(mailbox.fetchedUids).toEqual([]);
    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([1]);
    expect(await documentsService.list({ userId })).toHaveLength(0);
  });

  it("still processes a message at or under the configured size", async () => {
    await configureImap({ "email.imap.maxMessageSizeMb": 1 });
    const raw = await fixtureBuffer("plain-text-only.eml");
    const mailbox = createFakeMailbox({ raw: { 1: raw } });
    mailbox.seed("DocMind", [1]);
    mailbox.setSizeOverride(async () => raw.length);
    const email = buildService(async () => mailbox.client);

    await email.runOnce();

    expect(mailbox.fetchedUids).toEqual([1]);
    expect(mailbox.messagesIn("DocMind/Done")).toEqual([1]);
  });

  it("retries a failing message a bounded number of times, then moves it to Failed", async () => {
    await configureImap();
    const mailbox = createFakeMailbox();
    mailbox.seed("DocMind", [1]);
    mailbox.setFetchOverride(async () => {
      throw new Error("mailbox read failed, simulated");
    });
    const email = buildService(async () => mailbox.client, { messageRetryAttempts: 3 });

    await email.runOnce();
    expect(mailbox.messagesIn("DocMind")).toEqual([1]);
    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([]);

    await email.runOnce();
    expect(mailbox.messagesIn("DocMind")).toEqual([1]);
    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([]);

    await email.runOnce();
    expect(mailbox.messagesIn("DocMind")).toEqual([]);
    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([1]);
    expect(mailbox.fetchedUids).toHaveLength(3);
  });

  it("keeps handling later messages after an earlier one fails for good", async () => {
    await configureImap();
    const goodRaw = await fixtureBuffer("plain-text-only.eml");
    const mailbox = createFakeMailbox({ raw: { 2: goodRaw } });
    mailbox.seed("DocMind", [1, 2]);
    mailbox.setFetchOverride(async (uid) => {
      if (uid === 1) throw new Error("uid 1 is poisoned, simulated");
      const content = goodRaw;
      const source = new Readable({
        read() {
          this.push(content);
          this.push(null);
        },
      });
      return { uid, source };
    });
    // One attempt is enough for uid 1 to exhaust its retries in a single cycle, so
    // this test proves uid 2 is still handled in that same cycle rather than in a
    // separate one.
    const email = buildService(async () => mailbox.client, { messageRetryAttempts: 1 });

    await email.runOnce();

    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([1]);
    expect(mailbox.messagesIn("DocMind/Done")).toEqual([2]);
    expect(await documentsService.list({ userId })).toHaveLength(1);
  });

  // Regression test for treating a dropped connection as a bad message. Unlike the
  // "poisoned" tests above, which throw a plain Error to stand for something wrong
  // with the message itself, this throws the same AppError email.client.ts actually
  // produces for a real IMAP failure, so it must be read as a connection problem, not
  // charged to uid 1, and must stop the batch before uid 2 is ever touched.
  it("abandons the batch on a dropped connection, without charging the in-flight message a retry", async () => {
    await configureImap();
    const goodRaw = await fixtureBuffer("plain-text-only.eml");
    const mailbox = createFakeMailbox({ raw: { 1: goodRaw, 2: goodRaw } });
    mailbox.seed("DocMind", [1, 2]);
    mailbox.setFetchOverride(async (uid) => {
      if (uid === 1) {
        throw createError({ code: "email.imap_error", message: "IMAP download to imap.example.com: the connection was refused", status: 502 });
      }
      return { uid, source: new Readable({ read() { this.push(goodRaw); this.push(null); } }) };
    });
    const email = buildService(async () => mailbox.client, { messageRetryAttempts: 1 });

    await expect(email.runOnce()).rejects.toThrow(/connection was refused/);

    expect(mailbox.messagesIn("DocMind")).toEqual([1, 2]);
    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([]);
    expect(mailbox.messagesIn("DocMind/Done")).toEqual([]);
    // uid 2 was never even reached: the batch stopped at the connection failure.
    expect(mailbox.fetchedUids).toEqual([1]);

    // The connection recovers on the next cycle, and both messages that were never
    // touched, including the one that hit the drop, go through cleanly.
    mailbox.setFetchOverride(undefined);
    await email.runOnce();

    expect(mailbox.messagesIn("DocMind/Done")).toEqual([1, 2]);
    expect(mailbox.messagesIn("DocMind/Failed")).toEqual([]);
  });

  // Regression test for the safety the spec calls out: documents are committed before
  // the move to Done, so a crash between the two must leave the message to be handled
  // again rather than losing it, and the content-hash dedupe must make that replay
  // produce no duplicates.
  it("does not duplicate documents when the move to Done fails right after the documents are committed", async () => {
    await configureImap();
    const raw = await fixtureBuffer("attachment-with-note.eml");
    const mailbox = createFakeMailbox({ raw: { 1: raw } });
    mailbox.seed("DocMind", [1]);
    mailbox.failNextMove();
    const email = buildService(async () => mailbox.client);

    await expect(email.runOnce()).rejects.toThrow(/connection was refused/);

    expect(mailbox.messagesIn("DocMind")).toEqual([1]);
    expect(mailbox.messagesIn("DocMind/Done")).toEqual([]);
    const afterFirstCycle = await documentsService.list({ userId });
    expect(afterFirstCycle).toHaveLength(2);

    await email.runOnce();

    expect(mailbox.messagesIn("DocMind/Done")).toEqual([1]);
    const afterSecondCycle = await documentsService.list({ userId });
    expect(afterSecondCycle).toHaveLength(2);
  });

  it("takes a bounded batch, so a folder of thousands does not stall the process on its first run", async () => {
    await configureImap();
    const raw = await fixtureBuffer("plain-text-only.eml");
    const totalMessages = 5000;
    const mailbox = createFakeMailbox();
    mailbox.setFetchOverride(async (uid) => {
      const source = new Readable({
        read() {
          this.push(raw);
          this.push(null);
        },
      });
      return { uid, source };
    });
    mailbox.seed(
      "DocMind",
      Array.from({ length: totalMessages }, (_, i) => i + 1),
    );
    const email = buildService(async () => mailbox.client, { batchSize: 20 });

    await email.runOnce();

    expect(mailbox.fetchedUids).toHaveLength(20);
    expect(mailbox.messagesIn("DocMind")).toHaveLength(totalMessages - 20);
  });

  it("backs off after a connection failure and recovers", async () => {
    await configureImap();
    const mailbox = createFakeMailbox();
    let attempts = 0;
    const email = buildService(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network blip, simulated");
      return mailbox.client;
    });

    await expect(email.runOnce()).rejects.toThrow(/network blip/);
    await expect(email.runOnce()).resolves.toBeUndefined();
  });

  it("waits the configured pollSeconds between cycles, not the constructor default", async () => {
    await configureImap({ "email.imap.pollSeconds": 5 });
    const mailbox = createFakeMailbox();
    mailbox.seed("DocMind", []);
    let calls = 0;
    const email = buildService(
      async () => {
        calls += 1;
        return mailbox.client;
      },
      // Deliberately far from the configured pollSeconds, so the assertions below can
      // only pass if the setting, not this constructor default, drove the wait. A
      // short shutdown timeout keeps the cleanup below from waiting out a real five
      // seconds once the fake clock is gone and the loop's own pending wait can no
      // longer be advanced.
      { idleIntervalMs: 999_000, shutdownTimeoutMs: 50 },
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await email.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
    } finally {
      // Real timers first: stop()'s own shutdown race sets a real setTimeout, and the
      // loop's already-pending wait was scheduled on the fake clock, which is now
      // gone, so stop() can only ever resolve through its shutdown timeout here.
      vi.useRealTimers();
      await email.stop();
    }
  });

  it("returns from stop() even when a cycle is stuck", async () => {
    await configureImap();
    const client: ImapClient = {
      async messageSize() {
        return undefined;
      },
      async listFolder() {
        return new Promise(() => {});
      },
      async fetchMessage() {
        throw new Error("not used in this test");
      },
      async moveMessage() {},
      async ensureFolder() {},
      async close() {},
    };
    const email = buildService(async () => client, { idleIntervalMs: 10, shutdownTimeoutMs: 50 });

    await email.start();
    const startedAt = Date.now();
    await email.stop();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
  });

  // Regression test for the class of bug the link fetcher shipped with: a connection
  // closed before the thing it fetched had actually been read. The fake stream below
  // throws if anything tries to read it after close() has been called, which is
  // exactly what would happen if the loop closed the connection before mailparser had
  // finished walking the attachment.
  it("does not close the connection before an attachment stream has been fully read", async () => {
    await configureImap();
    const raw = await fixtureBuffer("attachment-with-note.eml");
    let closed = false;
    let pushedEverything = false;
    const client: ImapClient = {
      async messageSize() {
        return raw.length;
      },
      async listFolder({ limit }) {
        return [{ uid: 1 }].slice(0, limit);
      },
      async fetchMessage() {
        const source = new Readable({
          read() {
            if (closed) {
              this.destroy(new Error("read attempted after the connection was already closed"));
              return;
            }
            this.push(raw);
            this.push(null);
            pushedEverything = true;
          },
        });
        return { uid: 1, source };
      },
      async moveMessage() {},
      async ensureFolder() {},
      async close() {
        closed = true;
      },
    };
    const email = buildService(async () => client);

    await expect(email.runOnce()).resolves.toBeUndefined();

    expect(pushedEverything).toBe(true);
    const docs = await documentsService.list({ userId });
    expect(docs.map((d) => d.name)).toContain("invoice.pdf");
  });
});
