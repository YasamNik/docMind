import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("returns from stop() even when a cycle is stuck", async () => {
    await configureImap();
    const client: ImapClient = {
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
