import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createError } from "../../shared/errors/errors.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createDocumentsService } from "../documents/documents.usecases.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
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

function buildService(client: TelegramClient, fetchLinkPage: FetchLinkPage = fetchLinkPageNotConfigured) {
  return createTelegramService({
    settingsService,
    documentsService,
    getUserId: async () => userId,
    clientFactory: () => client,
    fetchLinkPage,
  });
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

  it("does not reprocess an update it already handled", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client, getUpdatesOffsets } = fakeTelegram({
      batches: [[updateWithText({ updateId: 7, fromId: PAIRED_ID, text: "a note" })], []],
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
});
