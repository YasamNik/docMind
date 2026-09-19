import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createError } from "../../shared/errors/errors.js";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { aiSettingDefinitions } from "../ai/ai.settings.js";
import type { AiAdapter, ChatMessage, ChatStreamPart, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";
import { createAiService } from "../ai/ai.usecases.js";
import { aiProviderRegistry } from "../ai/providers/index.js";
import { assistantSettingDefinitions, INSTRUCTIONS_KEY } from "../assistant/assistant.settings.js";
import { createAssistantService, type AssistantService } from "../assistant/assistant.usecases.js";
import { createChatService, type ChatService } from "../chat/chat.usecases.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { createDocumentsService } from "../documents/documents.usecases.js";
import { createSearchRepository } from "../search/search.repository.js";
import { searchSettingDefinitions } from "../search/search.settings.js";
import { createSearchService } from "../search/search.usecases.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createTagsService } from "../tags/tags.usecases.js";
import type { TelegramClient } from "./telegram.client.js";
import { telegramSettingDefinitions } from "./telegram.settings.js";
import { createTelegramService, type FetchLinkPage } from "./telegram.usecases.js";

function asyncIterableOf(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

// Wraps plain text chunks as the adapter's typed stream shape (see ai.types.ts). The
// telegram service only ever gets plain text back from aiService.streamChat, which
// unwraps this, so these tests still assert on plain concatenated strings.
function asyncChatPartsOf(chunks: string[]): AsyncIterable<ChatStreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield { type: "text", text: chunk };
    },
  };
}

// A plain chat message now makes a triage call before an answer exists: the model
// calls a tool on the first streamChat call, and the tool's own answering call is the
// second. Scripts that pair so a test only has to say what the tool call and the
// answer look like, instead of hand rolling call counting in every test.
function toolThenText({ tool, args, text }: { tool: string; args: unknown; text: string }): AiAdapter["streamChat"] {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "toolCall" as const, id: "call_1", name: tool, arguments: args };
        },
      };
    }
    return asyncChatPartsOf([text]);
  });
}

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
let chatService: ChatService;
let assistantService: AssistantService;
// Reassigned within a test to script what the model returns for that turn. Reading
// through this indirection, rather than rebuilding the whole ai/search/chat stack per
// test, is what lets "keeps the thread" script two different replies for two turns of
// the same conversation.
let streamChatImpl: AiAdapter["streamChat"];
// Empty by default, so supportsTools has nothing to restrict and a plain turn's
// triage call goes ahead. A test on the no-tools notice overrides this to report the
// configured model back with supportsTools: false.
let listModelsImpl: AiAdapter["listModels"];

function fakeChatAdapter(): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } }) as StructuredResult),
    streamText: vi.fn(async () => asyncIterableOf([])),
    streamChat: (...args) => streamChatImpl(...args),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: (...args) => listModelsImpl(...args),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function uploadWithChunk(name: string, text: string) {
  const { document } = await documentsService.upload({ userId, name, mimeType: "text/plain", body: Readable.from([text]) });
  await db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done' where id = ${document.id}`);
  const searchRepository = createSearchRepository({ db });
  await searchRepository.insertChunks([{ documentId: document.id, chunkIndex: 0, chunkText: text, tokenCount: 10, startChar: 0, endChar: text.length }]);
  return document.id;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-telegram-"));
  ({ db } = await createTestDatabase());
  settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry([
      ...storageSettingDefinitions,
      ...telegramSettingDefinitions,
      ...aiSettingDefinitions,
      ...searchSettingDefinitions,
      ...assistantSettingDefinitions,
    ]),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  const storageService = createStorageService({ settingsService, countDocuments: async () => 0 });
  documentsService = createDocumentsService({ db, storageService });

  // Not configured by default (no ai.model.chat), so a test that never touches the
  // assistant gets the same graceful "no model configured" path production would.
  streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Okay."]));
  listModelsImpl = vi.fn(async () => [] as ModelInfo[]);
  const adapter = fakeChatAdapter();
  const aiService = createAiService({
    settingsService,
    registry: aiProviderRegistry,
    adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter },
  });
  const searchService = createSearchService({ db, aiService, settingsService });
  chatService = createChatService({ db, aiService, searchService });
  assistantService = createAssistantService({ chatService, documentsService, aiService, settingsService });
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
    chatService,
    assistantService,
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

  it("files /note as a document, the same way plain text used to, with no model call at all", async () => {
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
    expect(streamChatImpl).not.toHaveBeenCalled();
  });

  it("does not create a chat session for a user who only ever sends /note", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    const { client } = fakeTelegram({
      batches: [[updateWithCommand({ updateId: 1, fromId: PAIRED_ID, command: "/note", argument: "buy milk" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(await chatService.listSessions(userId)).toHaveLength(0);
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
      chatService,
      assistantService,
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

describe("telegram service, the assistant", () => {
  async function pairAndConfigureChat() {
    await settingsService.set(userId, {
      "telegram.botToken": "111:token",
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://test-chat-model",
    });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    // The once-only note-migration notice is a Task 1 concern with its own tests;
    // pre-marking it sent keeps these tests focused on the conversation itself.
    await settingsService.setInternal(userId, "telegram.noteMigrationNoticeSent", true);
  }

  it("answers a document question by choosing answerFromDocuments, and names what it used", async () => {
    await pairAndConfigureChat();
    await uploadWithChunk("lease.txt", "The lease renews on March 1st.");
    streamChatImpl = toolThenText({ tool: "answerFromDocuments", args: {}, text: "The lease renews March 1st [1]." });
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "when does my lease renew?" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("The lease renews March 1st");
    expect(sent[0]?.text).toContain("lease.txt");
    expect(sent[0]?.text).not.toContain("[1]");
  });

  // The defect a live probe found: the triage call was told to answer from context it
  // is never given (Decision 2 sends it no retrieved chunks at all), so it reported
  // back that it had no way to look, even with answerFromDocuments right there in its
  // own tools array. Asserts on the actual system message the triage call sends, not on
  // what the model happens to do with it.
  it("gives the triage call a system message that never claims it has no way to look something up", async () => {
    await pairAndConfigureChat();
    let triageMessages: ChatMessage[] = [];
    let calls = 0;
    streamChatImpl = vi.fn(async (args) => {
      calls += 1;
      if (calls === 1) {
        triageMessages = args.messages;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "toolCall" as const, id: "call_1", name: "answerFromDocuments", arguments: {} };
          },
        };
      }
      return asyncChatPartsOf(["You have two documents on file [1][2]."]);
    });
    const { client } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what documents do i have?" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    const systemMessage = triageMessages.find((m) => m.role === "system")?.content ?? "";
    expect(systemMessage).not.toMatch(/context given to you/i);
    expect(systemMessage).not.toMatch(/context does not cover/i);
    expect(systemMessage).toMatch(/never tell the user you have no way to check/i);
    expect(systemMessage).toMatch(/use answerFromDocuments/i);
  });

  // The instructions document is user-editable text, not code, so the assistant must
  // not depend on it to know it can look something up. A terse custom document that
  // says nothing about documents at all must still leave the routing guidance in the
  // triage system message. A fake adapter cannot make a real tool choice, so this
  // checks the prompt content that would actually drive one.
  it("keeps the routing guidance in the triage prompt even when the user's own instructions say nothing about documents", async () => {
    await pairAndConfigureChat();
    await settingsService.setInternal(
      userId,
      INSTRUCTIONS_KEY,
      "Answer every message in exactly one short sentence. Always end your reply with the word BANANA.",
    );
    let triageMessages: ChatMessage[] = [];
    let calls = 0;
    streamChatImpl = vi.fn(async (args) => {
      calls += 1;
      if (calls === 1) {
        triageMessages = args.messages;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "toolCall" as const, id: "call_1", name: "answerFromDocuments", arguments: {} };
          },
        };
      }
      return asyncChatPartsOf(["You have two documents on file [1][2]. BANANA"]);
    });
    const { client } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what documents do i have?" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    const systemMessage = triageMessages.find((m) => m.role === "system")?.content ?? "";
    expect(systemMessage).toMatch(/use answerFromDocuments/i);
    expect(systemMessage).toMatch(/never tell the user you have no way to check/i);
  });

  it("searches the web when the model chooses it, without the user typing /web", async () => {
    await pairAndConfigureChat();
    streamChatImpl = toolThenText({
      tool: "searchWeb",
      args: { question: "weather in ankara tomorrow" },
      text: "Sunny and 22 degrees in Ankara tomorrow.",
    });
    const { client, sent } = fakeTelegram({
      batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what's the weather in ankara tomorrow" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Sunny and 22 degrees");
    expect(sent[0]?.text).toMatch(/web/i);
  });

  it("asks one short question back when the model chooses askUser", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "toolCall" as const, id: "call_1", name: "askUser", arguments: { question: "Should I file this under Finance or Personal" } };
      },
    }));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "sort this out" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("Should I file this under Finance or Personal?");
  });

  it("tells the user once when the chat model cannot use tools, and answers anyway", async () => {
    await pairAndConfigureChat();
    listModelsImpl = vi.fn(async () => [{ id: "test-chat-model", label: "Test", supportsTools: false }] as ModelInfo[]);
    await uploadWithChunk("invoice.txt", "Rent is $1200 per month.");
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["The rent is $1200 [1]."]));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what is my rent" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/tools/i);
    expect(sent[0]?.text).toContain("The rent is $1200");
    expect(sent[0]?.text).toContain("invoice.txt");
    expect(streamChatImpl).toHaveBeenCalledTimes(1);
  });

  it("answers an ordinary question without documents rather than refusing", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Morning! Nothing on your plate that I can see."]));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "good morning" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("Morning! Nothing on your plate that I can see.");
  });

  it("keeps the thread, so a follow up understands what it refers to", async () => {
    await pairAndConfigureChat();
    let call = 0;
    streamChatImpl = vi.fn(async () => asyncChatPartsOf([call++ === 0 ? "It's a Labrador." : "Yes, still a Labrador."]));
    const { client } = fakeTelegram({
      batches: [
        [updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what breed is my dog" })],
        [updateWithText({ updateId: 2, fromId: PAIRED_ID, text: "are you sure" })],
      ],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    const sessions = await chatService.listSessions(userId);
    expect(sessions).toHaveLength(1);
    const messages = await chatService.listMessages({ userId, sessionId: sessions[0]!.id });
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["what breed is my dog", "are you sure"]);
  });

  it("starts fresh after /new", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Sure."]));
    const { client, sent } = fakeTelegram({
      batches: [
        [updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what breed is my dog" })],
        [updateWithCommand({ updateId: 2, fromId: PAIRED_ID, command: "/new" })],
        [updateWithText({ updateId: 3, fromId: PAIRED_ID, text: "are you sure" })],
      ],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();
    await telegram.runOnce();

    const sessions = await chatService.listSessions(userId);
    expect(sessions).toHaveLength(2);
    expect(sent.some((m) => /fresh/i.test(m.text))).toBe(true);
  });

  it("splits an answer longer than a telegram message rather than truncating it", async () => {
    await pairAndConfigureChat();
    const longAnswer = "x".repeat(5000);
    streamChatImpl = vi.fn(async () => asyncChatPartsOf([longAnswer]));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "tell me a long story" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((m) => m.text.length <= 4096)).toBe(true);
    expect(sent.map((m) => m.text).join("")).toBe(longAnswer);
  });

  // Regression test: a send failing on a later part of a split reply used to escape
  // handleAssistantTurn uncaught, straight into pollUpdatesOnce's own retry loop, which
  // reran the whole turn from scratch: a second model call and a second copy of the
  // user's own message appended to the chat session. The reply was already generated,
  // so a delivery failure must be handled where it happens, not by redoing the turn.
  it("does not repeat the whole turn when delivering a later part of a split reply fails on every retry", async () => {
    await pairAndConfigureChat();
    const longAnswer = "x".repeat(5000);
    streamChatImpl = vi.fn(async () => asyncChatPartsOf([longAnswer]));
    let sendCalls = 0;
    const sent: { chatId: number; text: string }[] = [];
    const client: TelegramClient = {
      async getUpdates({ offset }) {
        return offset === 1 ? [updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "tell me a long story" })] : [];
      },
      async getFile() {
        throw new Error("not used in this test");
      },
      async sendMessage({ chatId, text }) {
        sendCalls += 1;
        // The first part delivers fine. Every attempt at the second part fails, standing
        // in for a send that never recovers within the bounded retry.
        if (sendCalls === 1) {
          sent.push({ chatId, text });
          return;
        }
        throw new Error("network blip, simulated");
      },
    };
    const telegram = buildService(client);

    await expect(telegram.runOnce()).resolves.toBeUndefined();

    expect(streamChatImpl).toHaveBeenCalledTimes(1);
    const sessions = await chatService.listSessions(userId);
    const messages = await chatService.listMessages({ userId, sessionId: sessions[0]!.id });
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("swallows a send that fails on every retry instead of throwing out of the poll cycle, and still advances the cursor", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Short reply."]));
    let getUpdatesCalls = 0;
    const client: TelegramClient = {
      async getUpdates() {
        getUpdatesCalls += 1;
        return getUpdatesCalls === 1 ? [updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "hello" })] : [];
      },
      async getFile() {
        throw new Error("not used in this test");
      },
      async sendMessage() {
        throw new Error("permanently blocked, simulated");
      },
    };
    const telegram = buildService(client);

    await expect(telegram.runOnce()).resolves.toBeUndefined();

    expect(await settingsService.get<number>(userId, "telegram.lastUpdateId")).toBe(1);
    expect(streamChatImpl).toHaveBeenCalledTimes(1);
  });

  it("delivers every part of a split reply, in order and with no duplicates, when a send fails once and succeeds on retry", async () => {
    await pairAndConfigureChat();
    const longAnswer = "x".repeat(5000);
    streamChatImpl = vi.fn(async () => asyncChatPartsOf([longAnswer]));
    let sendCalls = 0;
    const sent: { chatId: number; text: string }[] = [];
    const client: TelegramClient = {
      async getUpdates({ offset }) {
        return offset === 1 ? [updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "tell me a long story" })] : [];
      },
      async getFile() {
        throw new Error("not used in this test");
      },
      async sendMessage({ chatId, text }) {
        sendCalls += 1;
        // The second part's first attempt fails, then its retry succeeds.
        if (sendCalls === 2) throw new Error("network blip, simulated");
        sent.push({ chatId, text });
      },
    };
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.text).join("")).toBe(longAnswer);
  });

  it("says so when no chat model is configured, instead of failing silently", async () => {
    await settingsService.set(userId, { "telegram.botToken": "111:token" });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.noteMigrationNoticeSent", true);
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["should never be reached"]));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "what is my rent" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/no model configured|settings page/i);
    expect(streamChatImpl).not.toHaveBeenCalled();
  });

  it("does not spend a model call on a bare ok or an emoji", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["should never be reached"]));
    const { client, sent } = fakeTelegram({
      batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "ok" })], [updateWithText({ updateId: 2, fromId: PAIRED_ID, text: "👍" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    expect(streamChatImpl).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
  });

  it("treats a cheap acknowledgement as a real answer when it responds to the assistant's own question", async () => {
    await pairAndConfigureChat();
    let call = 0;
    streamChatImpl = vi.fn(async () =>
      asyncChatPartsOf([call++ === 0 ? "Do you want me to file this under Finance?" : "Filed it under Finance."]),
    );
    const { client, sent } = fakeTelegram({
      batches: [
        [updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "where should this go" })],
        [updateWithText({ updateId: 2, fromId: PAIRED_ID, text: "sure" })],
      ],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    expect(streamChatImpl).toHaveBeenCalledTimes(2);
    expect(sent[1]?.text).toContain("Filed it under Finance.");
    const sessions = await chatService.listSessions(userId);
    const messages = await chatService.listMessages({ userId, sessionId: sessions[0]!.id });
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["where should this go", "sure"]);
  });

  it("still treats sure as a cheap acknowledgement when there is no open question to answer", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["should never be reached"]));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "sure" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(streamChatImpl).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  // Regression test: a stored telegram.chatSessionId pointing at a chat_sessions row
  // that no longer exists, such as one deleted from the app's own Chat page, used to
  // reject chatService.sendMessage before the streaming generator's own try block, so
  // the rejection escaped handleAssistantTurn uncaught and the user got no reply at all.
  it("recovers when the stored chat session was deleted elsewhere, instead of going permanently silent", async () => {
    await pairAndConfigureChat();
    await settingsService.setInternal(userId, "telegram.chatSessionId", "session-that-no-longer-exists");
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Morning! Nothing on your plate that I can see."]));
    const { client, sent } = fakeTelegram({ batches: [[updateWithText({ updateId: 1, fromId: PAIRED_ID, text: "good morning" })]] });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("Morning! Nothing on your plate that I can see.");

    const newSessionId = await settingsService.get<string>(userId, "telegram.chatSessionId");
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe("session-that-no-longer-exists");
    const sessions = await chatService.listSessions(userId);
    expect(sessions.map((s) => s.id)).toContain(newSessionId);
  });

  // End-to-end confirmation of the runHandler fix (assistant.usecases.ts): the same
  // stale-session recovery above only ever fired for a plain message, since runTurn
  // rejects outright before any try/catch of its own. A slash command such as /web
  // runs through runCommand instead, so this proves the whole path still ends in a
  // real answer and a repaired pointer, not just the one narrow spot the unit-level
  // regression test in assistant.usecases.test.ts checks directly.
  it("recovers when the stored chat session was deleted elsewhere, for a /web command too", async () => {
    await pairAndConfigureChat();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
    await settingsService.setInternal(userId, "telegram.chatSessionId", "session-that-no-longer-exists");
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Around 5 degrees and cloudy in Ottawa today."]));
    const { client, sent } = fakeTelegram({
      batches: [[updateWithCommand({ updateId: 1, fromId: PAIRED_ID, command: "/web", argument: "what's the weather in ottawa" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Around 5 degrees and cloudy in Ottawa today.");
    expect(sent[0]?.text).not.toMatch(/not found/i);

    const newSessionId = await settingsService.get<string>(userId, "telegram.chatSessionId");
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe("session-that-no-longer-exists");
    const sessions = await chatService.listSessions(userId);
    expect(sessions.map((s) => s.id)).toContain(newSessionId);
  });
});

describe("telegram service, /web", () => {
  async function pairAndConfigureChat() {
    await settingsService.set(userId, {
      "telegram.botToken": "111:token",
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://test-chat-model",
    });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.noteMigrationNoticeSent", true);
  }

  it("attaches web search for a /web question, and not for the next plain one", async () => {
    await pairAndConfigureChat();
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["Around 5 degrees and cloudy in Ottawa today."]));
    const { client, sent } = fakeTelegram({
      batches: [
        [updateWithCommand({ updateId: 1, fromId: PAIRED_ID, command: "/web", argument: "what's the weather in ottawa" })],
        [updateWithText({ updateId: 2, fromId: PAIRED_ID, text: "what about my rent" })],
      ],
    });
    const telegram = buildService(client);

    await telegram.runOnce();
    await telegram.runOnce();

    expect(streamChatImpl).toHaveBeenCalledTimes(2);
    expect(streamChatImpl).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: "test-chat-model:online" }));
    expect(streamChatImpl).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: "test-chat-model" }));
    expect(sent[0]?.text).toMatch(/web/i);
  });

  it("says plainly that /web needs an OpenRouter chat model, when it is not", async () => {
    await settingsService.set(userId, {
      "telegram.botToken": "111:token",
      "ai.anthropic.apiKey": "sk-ant-test",
      "ai.model.chat": "anthropic://claude-sonnet-4-20250514",
    });
    await settingsService.setInternal(userId, "telegram.pairedUserId", PAIRED_ID);
    await settingsService.setInternal(userId, "telegram.noteMigrationNoticeSent", true);
    streamChatImpl = vi.fn(async () => asyncChatPartsOf(["should never be reached"]));
    const { client, sent } = fakeTelegram({
      batches: [[updateWithCommand({ updateId: 1, fromId: PAIRED_ID, command: "/web", argument: "what's the weather in ottawa" })]],
    });
    const telegram = buildService(client);

    await telegram.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/openrouter/i);
    expect(streamChatImpl).not.toHaveBeenCalled();
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
      chatService,
      assistantService,
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
