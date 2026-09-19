import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createError } from "../../shared/errors/errors.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { createDocumentsService } from "../documents/documents.usecases.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createTagsService } from "../tags/tags.usecases.js";
import type { TelegramClient } from "./telegram.client.js";
import { telegramSettingDefinitions } from "./telegram.settings.js";
import { createTelegramService, type FetchLinkPage } from "./telegram.usecases.js";

const userId = "user-1";
const PAIRED_ID = 111;
const OTHER_ID = 222;

type FileFixture = { content: string; fileName?: string } | { tooLarge: true };

function fakeTelegram({ batches, files = {} }: { batches: (unknown[] | Error)[]; files?: Record<string, FileFixture> }) {
  const sent: { chatId: number; text: string }[] = [];
  const getUpdatesOffsets: number[] = [];
  let batchIndex = 0;

  const client: TelegramClient = {
    async getUpdates({ offset }) {
      getUpdatesOffsets.push(offset);
      const batch = batches[batchIndex];
      batchIndex += 1;
      if (batch instanceof Error) throw batch;
      return batch ?? [];
    },
    async getFile({ fileId }) {
      const fixture = files[fileId];
      if (!fixture) throw new Error(`no fixture for file ${fileId}`);
      if ("tooLarge" in fixture) {
        throw createError({ code: "telegram.file_too_large", message: "File is 25.0 MB, over Telegram's 20 MB download limit", status: 413 });
      }
      return { stream: Readable.from([fixture.content]), fileName: fixture.fileName ?? "file.bin", sizeBytes: fixture.content.length };
    },
    async sendMessage({ chatId, text }) {
      sent.push({ chatId, text });
    },
  };

  return { client, sent, getUpdatesOffsets };
}

function updateWithText({ updateId, fromId, text }: { updateId: number; fromId: number; text: string }) {
  return { update_id: updateId, message: { message_id: updateId, from: { id: fromId, first_name: "Alex" }, chat: { id: fromId }, text } };
}

function updateWithCommand({
  updateId,
  fromId,
  command,
  argument,
}: {
  updateId: number;
  fromId: number;
  command: string;
  argument?: string;
}) {
  const text = argument ? `${command} ${argument}` : command;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, first_name: "Alex" },
      chat: { id: fromId },
      text,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  };
}

function updateWithDocument({
  updateId,
  fromId,
  fileId,
  fileName,
  mimeType = "application/pdf",
  caption,
}: {
  updateId: number;
  fromId: number;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, first_name: "Alex" },
      chat: { id: fromId },
      caption,
      document: { file_id: fileId, file_name: fileName, mime_type: mimeType },
    },
  };
}

function updateWithLink({ updateId, fromId, url }: { updateId: number; fromId: number; url: string }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, first_name: "Alex" },
      chat: { id: fromId },
      text: url,
      entities: [{ type: "url", offset: 0, length: url.length }],
    },
  };
}

function updateWithPhoto({ updateId, fromId, fileId, caption }: { updateId: number; fromId: number; fileId: string; caption?: string }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, first_name: "Alex" },
      chat: { id: fromId },
      caption,
      photo: [{ file_id: fileId, width: 800, height: 600 }],
    },
  };
}

let root: string;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
let settingsService: ReturnType<typeof createSettingsService>;
let documentsService: ReturnType<typeof createDocumentsService>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-telegram-"));
  ({ db } = await createTestDatabase());
  settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry([...storageSettingDefinitions, ...telegramSettingDefinitions]),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  const storageService = createStorageService({ settingsService, countDocuments: async () => 0 });
  documentsService = createDocumentsService({ db, storageService });
});

afterEach(() => rm(root, { recursive: true, force: true }));

// No test may reach the real fetcher: link-fetch.ts has its own suite that covers the
// guard with fakes of its own. A test that exercises a link intent overrides this.
const fetchLinkPageNotConfigured: FetchLinkPage = () => {
  throw new Error("this test sent a link but did not configure fetchLinkPage");
};

function buildService(
  client: TelegramClient,
  fetchLinkPage: FetchLinkPage = fetchLinkPageNotConfigured,
  overrides: Partial<Parameters<typeof createTelegramService>[0]> = {},
) {
  return createTelegramService({
    db,
    settingsService,
    documentsService,
    getUserId: async () => userId,
    clientFactory: () => client,
    fetchLinkPage,
    // Zero rather than the real backoff, so a test exercising a poisoned update does
    // not have to sit through real delays between retries.
    updateRetryDelayMs: () => 0,
    ...overrides,
  });
}

// The document is finished the moment both statuses land in a terminal state, so
// tests move it there directly rather than running the real rules and summary jobs.
async function markSortedAndSummarized({
  documentId,
  ruleStatus = "done",
  summaryStatus = "done",
}: {
  documentId: string;
  ruleStatus?: string;
  summaryStatus?: string;
}) {
  const repository = createDocumentsRepository({ db });
  await repository.update({ userId, documentId, patch: { ruleStatus, summaryStatus, updatedAt: new Date().toISOString() } });
}

describe("telegram service", () => {
  it("does nothing at all while no bot token is configured", async () => {
    const { client, sent, getUpdatesOffsets } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(getUpdatesOffsets).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("pairs with the first sender who quotes the code, then ignores everyone else", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairingCode", "ABC123");
    const { client, sent } = fakeTelegram({
      batches: [
        [
          updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "abc123" }),
          updateWithText({ updateId: 2, fromId: OTHER_ID, text: "ABC123" }),
        ],
      ],
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await settingsService.get(userId, "telegram.pairedUserId")).toBe(PAIRED_ID);
    expect(sent).toEqual([{ chatId: PAIRED_ID, text: expect.stringMatching(/paired/i) }]);
  });

  it("stores the sender's display name when pairing succeeds", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairingCode", "ABC123");
    const { client } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "abc123" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await settingsService.get(userId, "telegram.pairedName")).toBe("Alex");
  });

  it("says nothing at all when a pairing attempt does not match the stored code", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairingCode", "ABC123");
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "WRONGCODE" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await settingsService.get(userId, "telegram.pairedUserId")).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("turns a file from the paired user into a document that knows it came from telegram", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({
      batches: [[updateWithDocument({ updateId: 1, fromId: PAIRED_ID, fileId: "file-1", fileName: "receipt.pdf" })]],
      files: { "file-1": { content: "pdf bytes" } },
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    const [document] = await documentsService.list({ userId });
    expect(document).toMatchObject({ name: "receipt.pdf", source: "telegram" });
    expect(sent.map((m) => m.text)).toContainEqual(expect.stringMatching(/got it/i));
  });

  it("names a captioned photo from the caption rather than a timestamp", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client } = fakeTelegram({
      batches: [[updateWithPhoto({ updateId: 1, fromId: PAIRED_ID, fileId: "photo-1", caption: "hydro march" })]],
      files: { "photo-1": { content: "jpeg bytes" } },
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    const [document] = await documentsService.list({ userId });
    expect(document?.name).toBe("hydro march.jpg");
  });

  it("tells the sender when a file is too large for Telegram to hand over", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({
      batches: [[updateWithDocument({ updateId: 1, fromId: PAIRED_ID, fileId: "big-file", fileName: "huge.pdf" })]],
      files: { "big-file": { tooLarge: true } },
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(0);
    expect(sent.map((m) => m.text)).toContainEqual(expect.stringMatching(/20 ?mb/i));
  });

  it("says it already has a file that was sent twice, rather than going quiet", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({
      batches: [
        [
          updateWithDocument({ updateId: 1, fromId: PAIRED_ID, fileId: "file-1", fileName: "receipt.pdf" }),
          updateWithDocument({ updateId: 2, fromId: PAIRED_ID, fileId: "file-2", fileName: "receipt-again.pdf" }),
        ],
      ],
      files: { "file-1": { content: "same bytes" }, "file-2": { content: "same bytes" } },
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(1);
    expect(sent.map((m) => m.text)).toContainEqual(expect.stringMatching(/already/i));
  });

  it("mentions compression the first time a photo arrives, and not the second", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({
      batches: [
        [
          updateWithPhoto({ updateId: 1, fromId: PAIRED_ID, fileId: "photo-1" }),
          updateWithPhoto({ updateId: 2, fromId: PAIRED_ID, fileId: "photo-2" }),
        ],
      ],
      files: { "photo-1": { content: "photo one" }, "photo-2": { content: "photo two" } },
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    const compressionNotices = sent.filter((m) => /compress/i.test(m.text));
    expect(compressionNotices).toHaveLength(1);
  });

  it("turns a link into a document holding the fetched page's text", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const url = "https://example.com/kettles";
    const fetchLinkPage: FetchLinkPage = async () => ({ title: "Kettles", text: "Kettles boil fast.", finalUrl: url });
    const { client, sent } = fakeTelegram({ batches: [[updateWithLink({ updateId: 1, fromId: PAIRED_ID, url })]] });
    const telegram = buildService(client, fetchLinkPage);

    await telegram.runOnce();

    const [document] = await documentsService.list({ userId });
    expect(document).toMatchObject({ name: "Kettles.txt", source: "telegram" });
    expect(sent.map((m) => m.text)).toContainEqual(expect.stringMatching(/got it/i));
  });

  it("replies with the plain reason when the link guard refuses a url", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const url = "https://localhost.attacker.test/";
    const fetchLinkPage: FetchLinkPage = async () => {
      throw createError({ code: "telegram.link_refused", message: "Link refused: not a public address", status: 400 });
    };
    const { client, sent } = fakeTelegram({ batches: [[updateWithLink({ updateId: 1, fromId: PAIRED_ID, url })]] });
    const telegram = buildService(client, fetchLinkPage);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(0);
    expect(sent).toEqual([{ chatId: PAIRED_ID, text: "Link refused: not a public address" }]);
  });

  it("says it already has a link that was sent twice, rather than going quiet", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const urlOne = "https://example.com/kettles";
    const urlTwo = "https://example.com/kettles-again";
    const fetchLinkPage: FetchLinkPage = async () => ({ title: "Kettles", text: "Kettles boil fast.", finalUrl: urlOne });
    const { client, sent } = fakeTelegram({
      batches: [[updateWithLink({ updateId: 1, fromId: PAIRED_ID, url: urlOne }), updateWithLink({ updateId: 2, fromId: PAIRED_ID, url: urlTwo })]],
    });
    const telegram = buildService(client, fetchLinkPage);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(1);
    expect(sent.map((m) => m.text)).toContainEqual(expect.stringMatching(/already/i));
  });

  it("never acts on a message from an unpaired user id", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: OTHER_ID, text: "hello there" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("no longer files plain text as a note", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.noteMigrationNoticeSent", true);
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "buy milk" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("files /note as a document, the same way plain text used to", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({
      batches: [[updateWithCommand({ updateId: 1, fromId: PAIRED_ID, command: "/note", argument: "buy milk" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    const documents = await documentsService.list({ userId });
    expect(documents.map((d) => d.name)).toContain("buy milk.txt");
    expect(sent[0]?.text).toMatch(/got it/i);
  });

  it("asks for the note text when /note arrives with nothing after it", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({ batches: [[updateWithCommand({ updateId: 1, fromId: PAIRED_ID, command: "/note" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await documentsService.list({ userId })).toHaveLength(0);
    expect(sent[0]?.text).toMatch(/note/i);
  });

  it("mentions once that plain text now starts a conversation, and not the second time", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, sent } = fakeTelegram({
      batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "hey" })], [updateWithText({ updateId: 2, fromId: PAIRED_ID, text: "hey again" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    expect(sent).toHaveLength(3);
    expect(sent[1]?.text).toMatch(/note/i);
  });

  it("does not reprocess an update it already handled", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, getUpdatesOffsets } = fakeTelegram({
      batches: [[updateWithCommand({ updateId: 7, fromId: PAIRED_ID, command: "/note", argument: "a note" })], []],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    expect(getUpdatesOffsets).toEqual([1, 8]);
    expect(await settingsService.get(userId, "telegram.lastUpdateId")).toBe(7);
  });

  it("backs off after a failure and recovers on the next cycle", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    const { client } = fakeTelegram({ batches: [new Error("network blip"), []] });
    const telegram = buildService(client);

    await expect(telegram.runOnce()).rejects.toThrow(/network blip/);
    await expect(telegram.runOnce()).resolves.toBeUndefined();
  });

  // Regression test: handleUpdate throwing used to escape pollUpdatesOnce before the
  // cursor advanced, so a single message that always fails held every later update in
  // the same batch, and every future poll, hostage behind it.
  it("keeps handling later updates in the same batch after an earlier one fails on every retry", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client } = fakeTelegram({
      batches: [
        [
          updateWithDocument({ updateId: 1, fromId: PAIRED_ID, fileId: "missing-file", fileName: "ghost.pdf" }),
          updateWithCommand({ updateId: 2, fromId: PAIRED_ID, command: "/note", argument: "a note that should still land" }),
        ],
      ],
      // No fixture for "missing-file": getFile throws a plain Error every attempt.
    });
    const telegram = buildService(client);

    await expect(telegram.runOnce()).resolves.toBeUndefined();

    const documents = await documentsService.list({ userId });
    expect(documents.map((d) => d.name)).toContain("a note that should still land.txt");
  });

  it("does not let a poisoned update block the next poll cycle", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, getUpdatesOffsets } = fakeTelegram({
      batches: [
        [updateWithDocument({ updateId: 5, fromId: PAIRED_ID, fileId: "missing-file", fileName: "ghost.pdf" })],
        [updateWithCommand({ updateId: 6, fromId: PAIRED_ID, command: "/note", argument: "still alive" })],
      ],
    });
    const telegram = buildService(client);

    await expect(telegram.runOnce()).resolves.toBeUndefined();
    await expect(telegram.runOnce()).resolves.toBeUndefined();

    expect(getUpdatesOffsets).toEqual([1, 6]);
    const documents = await documentsService.list({ userId });
    expect(documents.map((d) => d.name)).toContain("still alive.txt");
  });

  // Regression test: stop() used to await both loops with no bound, so a loop stuck on
  // a call that never resolves kept the process's shutdown handler from ever finishing.
  it("returns from stop() even when a loop is stuck, instead of hanging forever", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    const client: TelegramClient = {
      async getUpdates() {
        return new Promise(() => {});
      },
      async getFile() {
        throw new Error("not used in this test");
      },
      async sendMessage() {},
    };
    const telegram = createTelegramService({
      db,
      settingsService,
      documentsService,
      getUserId: async () => userId,
      clientFactory: () => client,
      fetchLinkPage: fetchLinkPageNotConfigured,
      idleIntervalMs: 10,
      notifyIntervalMs: 10,
      shutdownTimeoutMs: 50,
    });

    await telegram.start();
    const startedAt = Date.now();
    await telegram.stop();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("telegram service, the second reply", () => {
  it("reports a document once both the summary and the rules have finished", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const tagsService = createTagsService({ db });
    const category = await tagsService.createCategory({ userId, name: "Finance" });
    const tag = await tagsService.createTag({ userId, name: "Receipts" });

    const { document } = await documentsService.upload({
      userId,
      name: "invoice.pdf",
      mimeType: "application/pdf",
      body: Readable.from(["invoice bytes"]),
      source: "telegram",
    });
    await tagsService.setDocumentCategory({ userId, documentId: document.id, categoryId: category.id });
    await tagsService.setDocumentTag({ userId, documentId: document.id, tagId: tag.id });
    await markSortedAndSummarized({ documentId: document.id });

    const { client, sent } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(PAIRED_ID);
    expect(sent[0]?.text).toContain("invoice.pdf");
    expect(sent[0]?.text).toContain("Finance");
    expect(sent[0]?.text).toContain("Receipts");
    expect(sent[0]?.text).toContain(document.id);
  });

  it("does not report the same document twice", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const { document } = await documentsService.upload({
      userId,
      name: "note.txt",
      mimeType: "text/plain",
      body: Readable.from(["a note"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: document.id });

    const { client, sent } = fakeTelegram({ batches: [[], []] });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    expect(sent).toHaveLength(1);
  });

  it("says nothing about a document uploaded in the browser", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const { document } = await documentsService.upload({
      userId,
      name: "manual.txt",
      mimeType: "text/plain",
      body: Readable.from(["typed by hand"]),
    });
    await markSortedAndSummarized({ documentId: document.id });

    const { client, sent } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(0);
  });

  it("waits while the summary is still running", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const { document } = await documentsService.upload({
      userId,
      name: "pending.txt",
      mimeType: "text/plain",
      body: Readable.from(["still working"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: document.id, summaryStatus: "processing" });

    const { client, sent } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(0);
  });

  it("still reports a document whose sorting failed, naming the stage", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const { document } = await documentsService.upload({
      userId,
      name: "unsortable.txt",
      mimeType: "text/plain",
      body: Readable.from(["could not be sorted"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: document.id, ruleStatus: "failed" });

    const { client, sent } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("unsortable.txt");
    expect(sent[0]?.text).toMatch(/sorting failed/i);
  });

  it("does not announce the back catalogue on the very first run", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    // No telegram.lastReportedAt stored at all yet: this is the very first cycle.
    const { document } = await documentsService.upload({
      userId,
      name: "old.txt",
      mimeType: "text/plain",
      body: Readable.from(["already here before pairing"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: document.id });

    const { client, sent } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(0);
    expect(await settingsService.get<string>(userId, "telegram.lastReportedAt")).not.toBe("");
  });

  // Regression test: the watermark used to be a plain createdAt string, so a document
  // that lands at the exact same createdAt as the one already reported could never
  // satisfy gt(createdAt, since) again and was dropped forever.
  it("still reports a document that shares a createdAt with the one already reported", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const repository = createDocumentsRepository({ db });
    const sharedTimestamp = "2024-01-01T00:00:00.000Z";

    const { document: docA } = await documentsService.upload({
      userId,
      name: "a.txt",
      mimeType: "text/plain",
      body: Readable.from(["a"]),
      source: "telegram",
    });
    const { document: docB } = await documentsService.upload({
      userId,
      name: "b.txt",
      mimeType: "text/plain",
      body: Readable.from(["b"]),
      source: "telegram",
    });
    for (const doc of [docA, docB]) {
      await markSortedAndSummarized({ documentId: doc.id });
      await repository.update({ userId, documentId: doc.id, patch: { createdAt: sharedTimestamp } });
    }
    // Sorted so the test does not depend on which of the two random ids happens to be
    // smaller: the lexicographically earlier one is treated as already reported.
    const [alreadyReported, stillPending] = [docA, docB].sort((x, y) => (x.id < y.id ? -1 : 1));
    await settingsService.setInternal(userId, "telegram.lastReportedAt", sharedTimestamp);
    await settingsService.setInternal(userId, "telegram.lastReportedId", alreadyReported.id);

    const { client, sent } = fakeTelegram({ batches: [[]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(stillPending.name);
  });

  // Regression test: the watermark used to be written once after the whole loop, so a
  // send that threw partway through a batch caused every document sent before it to be
  // announced again on the next attempt.
  it("does not re-announce a document already sent when a later send in the same batch fails", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const repository = createDocumentsRepository({ db });

    const { document: docA } = await documentsService.upload({
      userId,
      name: "first.txt",
      mimeType: "text/plain",
      body: Readable.from(["first"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: docA.id });
    await repository.update({ userId, documentId: docA.id, patch: { createdAt: "2024-01-01T00:00:00.000Z" } });

    const { document: docB } = await documentsService.upload({
      userId,
      name: "second.txt",
      mimeType: "text/plain",
      body: Readable.from(["second"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: docB.id });
    await repository.update({ userId, documentId: docB.id, patch: { createdAt: "2024-01-01T00:00:01.000Z" } });

    const sent: { chatId: number; text: string }[] = [];
    let sendCount = 0;
    const client: TelegramClient = {
      async getUpdates() {
        return [];
      },
      async getFile() {
        throw new Error("not used in this test");
      },
      async sendMessage({ chatId, text }) {
        sendCount += 1;
        if (sendCount === 2) throw new Error("blocked by user, simulated");
        sent.push({ chatId, text });
      },
    };
    const telegram = buildService(client);

    await expect(telegram.runOnce()).rejects.toThrow(/blocked by user/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("first.txt");

    // The second send now succeeds, on a later cycle.
    await telegram.runOnce();

    expect(sent.filter((m) => m.text.includes("first.txt"))).toHaveLength(1);
    expect(sent.some((m) => m.text.includes("second.txt"))).toBe(true);
  });
});

describe("telegram service, background loops", () => {
  // Regression test for the second reply arriving up to pollTimeoutSeconds late: the
  // update poll used to gate the finished-document report behind it in the same cycle.
  it("sends the finished document report while an update poll is still outstanding", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.lastReportedAt", "2020-01-01T00:00:00.000Z");
    const { document } = await documentsService.upload({
      userId,
      name: "slow-poll.txt",
      mimeType: "text/plain",
      body: Readable.from(["waiting on a slow poll"]),
      source: "telegram",
    });
    await markSortedAndSummarized({ documentId: document.id });

    const sent: { chatId: number; text: string }[] = [];
    let getUpdatesCalls = 0;
    let releaseGetUpdates: (() => void) | undefined;
    // Stays unresolved until the test releases it, standing in for a long poll that has
    // not come back yet.
    const outstandingPoll = new Promise<void>((resolve) => {
      releaseGetUpdates = resolve;
    });

    const client: TelegramClient = {
      async getUpdates() {
        getUpdatesCalls += 1;
        await outstandingPoll;
        return [];
      },
      async getFile() {
        throw new Error("not used in this test");
      },
      async sendMessage({ chatId, text }) {
        sent.push({ chatId, text });
      },
    };

    const telegram = createTelegramService({
      db,
      settingsService,
      documentsService,
      getUserId: async () => userId,
      clientFactory: () => client,
      fetchLinkPage: fetchLinkPageNotConfigured,
      idleIntervalMs: 10,
      notifyIntervalMs: 20,
    });

    await telegram.start();
    try {
      const deadline = Date.now() + 2000;
      while (sent.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(getUpdatesCalls).toBeGreaterThan(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain("slow-poll.txt");
    } finally {
      releaseGetUpdates?.();
      await telegram.stop();
    }
  });
});
