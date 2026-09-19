import { describe, expect, it } from "vitest";
import type { TelegramUpdate } from "./telegram.schemas.js";
import {
  acknowledgementReply,
  assistantReplyText,
  assistantTroubleReply,
  isAnsweringAQuestion,
  compressedPhotoNotice,
  duplicateReply,
  fileDocumentName,
  fileTooLargeReply,
  finishedDocumentReply,
  intentOf,
  isCheapMessage,
  linkDocumentBody,
  linkDocumentName,
  newPairingCode,
  notesMovedNotice,
  pairingSucceededReply,
  receivedReply,
  splitForTelegram,
  stripCitationMarkers,
} from "./telegram.models.js";

function baseUpdate(message: NonNullable<TelegramUpdate["message"]>): TelegramUpdate {
  return { update_id: 1, message };
}

describe("telegram models", () => {
  it("reads a document message as a file", () => {
    const update = baseUpdate({
      message_id: 10,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      document: { file_id: "file_123", file_name: "receipt.pdf", mime_type: "application/pdf", file_size: 2048 },
    });

    expect(intentOf(update, { paired: true })).toEqual({
      kind: "file",
      fileId: "file_123",
      fileName: "receipt.pdf",
      mimeType: "application/pdf",
      compressedPhoto: false,
    });
  });

  it("takes the largest size of a photo, and marks it compressed", () => {
    const update = baseUpdate({
      message_id: 11,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      photo: [
        { file_id: "small", width: 90, height: 90 },
        { file_id: "big", width: 800, height: 600 },
        { file_id: "medium", width: 320, height: 240 },
      ],
    });

    expect(intentOf(update, { paired: true })).toEqual({
      kind: "file",
      fileId: "big",
      fileName: undefined,
      mimeType: "image/jpeg",
      compressedPhoto: true,
    });
  });

  it("reads a message Telegram marked entirely as a url as a link", () => {
    const plainUrl = "https://example.com/receipt";
    const asPlainUrl = baseUpdate({
      message_id: 12,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: plainUrl,
      entities: [{ type: "url", offset: 0, length: plainUrl.length }],
    });
    expect(intentOf(asPlainUrl, { paired: true })).toEqual({ kind: "link", url: plainUrl });

    const displayText = "the bank statement";
    const asTextLink = baseUpdate({
      message_id: 13,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: displayText,
      entities: [{ type: "text_link", offset: 0, length: displayText.length, url: "https://bank.example/statement" }],
    });
    expect(intentOf(asTextLink, { paired: true })).toEqual({ kind: "link", url: "https://bank.example/statement" });

    const partiallyLinked = "check this out: https://example.com";
    const url = "https://example.com";
    const notWholeMessage = baseUpdate({
      message_id: 14,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: partiallyLinked,
      entities: [{ type: "url", offset: partiallyLinked.length - url.length, length: url.length }],
    });
    expect(intentOf(notWholeMessage, { paired: true })).toEqual({ kind: "chat", text: partiallyLinked });
  });

  it("reads plain text as something to answer, not something to file", () => {
    const update = baseUpdate({
      message_id: 15,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "where is my driver licence?",
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "chat", text: "where is my driver licence?" });
  });

  it("reads text as a pairing code only while unpaired", () => {
    const update = baseUpdate({
      message_id: 16,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "vwx234",
    });

    expect(intentOf(update, { paired: false })).toEqual({ kind: "pairing", code: "VWX234" });
    expect(intentOf(update, { paired: true })).toEqual({ kind: "chat", text: "vwx234" });
  });

  it("reads /note as a note, and keeps the text after the command", () => {
    const update = baseUpdate({
      message_id: 19,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "/note buy milk",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "note", text: "buy milk" });
  });

  it("accepts a command sent through Telegram's menu, with the bot username on it", () => {
    const update = baseUpdate({
      message_id: 20,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "/note@docmind_bot buy milk",
      entities: [{ type: "bot_command", offset: 0, length: "/note@docmind_bot".length }],
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "note", text: "buy milk" });
  });

  it("does not treat a slash inside a sentence as a command", () => {
    const update = baseUpdate({
      message_id: 21,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "the ratio is 3/4 note that",
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "chat", text: "the ratio is 3/4 note that" });
  });

  it("asks for the note when /note arrives with nothing after it", () => {
    const update = baseUpdate({
      message_id: 22,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "/note",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "note", text: "" });
  });

  it("reads /new as starting a fresh conversation", () => {
    const update = baseUpdate({
      message_id: 23,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "/new",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "newThread" });
  });

  it("reads /web as a question, keeping the text after the command", () => {
    const update = baseUpdate({
      message_id: 24,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "/web who won the game last night",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "web", text: "who won the game last night" });
  });

  it("treats a command Telegram did not mark at offset zero as plain text", () => {
    const update = baseUpdate({
      message_id: 25,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "he said /note it down",
      entities: [{ type: "bot_command", offset: 8, length: 5 }],
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "chat", text: "he said /note it down" });
  });

  it("ignores stickers, locations and edits", () => {
    const sticker = baseUpdate({ message_id: 17, from: { id: 111, first_name: "Alex" }, chat: { id: 111 } });
    expect(intentOf(sticker, { paired: true })).toEqual({ kind: "ignore" });

    const edit: TelegramUpdate = { update_id: 2 };
    expect(intentOf(edit, { paired: true })).toEqual({ kind: "ignore" });

    const blank = baseUpdate({ message_id: 18, from: { id: 111, first_name: "Alex" }, chat: { id: 111 }, text: "   " });
    expect(intentOf(blank, { paired: true })).toEqual({ kind: "ignore" });
  });

  it("generates a pairing code with no ambiguous characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(newPairingCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("writes reply text a person would text back", () => {
    expect(pairingSucceededReply()).toMatch(/paired/i);
    expect(receivedReply("receipt.pdf")).toMatch(/got it/i);
    expect(receivedReply("receipt.pdf")).toContain("receipt.pdf");
    expect(duplicateReply("receipt.pdf")).toMatch(/already/i);
    expect(fileTooLargeReply()).toMatch(/20 ?mb/i);
    expect(compressedPhotoNotice()).toMatch(/compress/i);
  });

  it("apologizes in the module's own voice when a turn fails outright", () => {
    expect(assistantTroubleReply().length).toBeGreaterThan(0);
    expect(assistantTroubleReply()).not.toMatch(/error|exception/i);
  });

  it("reads a cheap word as answering the assistant's own question when its last message asked one", () => {
    expect(isAnsweringAQuestion("Do you want me to file this under Finance?")).toBe(true);
    expect(isAnsweringAQuestion("Filed it under Finance.")).toBe(false);
    expect(isAnsweringAQuestion(undefined)).toBe(false);
  });

  it("tells someone once that notes now need /note", () => {
    expect(notesMovedNotice()).toMatch(/\/note/);
  });

  it("leaves a short reply as one message", () => {
    expect(splitForTelegram("short answer")).toEqual(["short answer"]);
  });

  it("splits a long reply on a paragraph break near the limit", () => {
    const first = "a".repeat(3000);
    const second = "b".repeat(3000);
    const parts = splitForTelegram(`${first}\n\n${second}`, 4096);
    expect(parts).toEqual([first, second]);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
  });

  it("hard splits a reply with no good paragraph break, without losing any text", () => {
    const text = "z".repeat(9000);
    const parts = splitForTelegram(text, 4096);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    expect(parts.join("")).toBe(text);
  });

  it("removes bracketed citation markers a text message cannot render", () => {
    expect(stripCitationMarkers("The rent is $1200 [1].")).toBe("The rent is $1200.");
    expect(stripCitationMarkers("No sources here.")).toBe("No sources here.");
  });

  it("names the document a reply used, once per document", () => {
    const reply = assistantReplyText({ answer: "The rent is $1200.", sourceNames: ["lease.pdf", "lease.pdf"] });
    expect(reply).toBe("The rent is $1200.\n\nUsed lease.pdf.");
  });

  it("names more than one document when more than one was used", () => {
    const reply = assistantReplyText({ answer: "Two things.", sourceNames: ["a.pdf", "b.pdf"] });
    expect(reply).toBe("Two things.\n\nUsed a.pdf, b.pdf.");
  });

  it("leaves a reply alone when nothing was used", () => {
    expect(assistantReplyText({ answer: "Morning!", sourceNames: [] })).toBe("Morning!");
  });

  it("says it searched the web when a /web turn answered", () => {
    const reply = assistantReplyText({ answer: "Around 5 degrees and cloudy.", sourceNames: [], web: true });
    expect(reply).toBe("Around 5 degrees and cloudy.\n\nSearched the web for this.");
  });

  it("names both the web and a document when a /web turn also cited one", () => {
    const reply = assistantReplyText({ answer: "Your policy covers that.", sourceNames: ["policy.pdf"], web: true });
    expect(reply).toBe("Your policy covers that.\n\nSearched the web for this. Used policy.pdf.");
  });

  it("treats punctuation-only text and a lone emoji as cheap, not worth a model call", () => {
    expect(isCheapMessage("ok")).toBe(true);
    expect(isCheapMessage("OK!")).toBe(true);
    expect(isCheapMessage("👍")).toBe(true);
    expect(isCheapMessage("...")).toBe(true);
    expect(isCheapMessage("!!")).toBe(true);
  });

  it("does not treat an ordinary question as cheap", () => {
    expect(isCheapMessage("what time is it")).toBe(false);
    expect(isCheapMessage("3/4 cup of sugar")).toBe(false);
  });

  it("acknowledges a cheap message without pretending to have answered anything", () => {
    expect(acknowledgementReply().length).toBeGreaterThan(0);
  });

  it("names a file document from telegram's own filename first", () => {
    const intent = { kind: "file", fileId: "f1", fileName: "receipt.pdf", mimeType: "application/pdf", compressedPhoto: false } as const;
    expect(fileDocumentName({ intent, caption: "hydro march", messageId: 1, now: new Date("2026-09-18T00:00:00Z") })).toBe("receipt.pdf");
  });

  it("names a captioned photo from the caption instead of a timestamp", () => {
    const intent = { kind: "file", fileId: "f2", fileName: undefined, mimeType: "image/jpeg", compressedPhoto: true } as const;
    expect(fileDocumentName({ intent, caption: "hydro march", messageId: 2, now: new Date("2026-09-18T00:00:00Z") })).toBe("hydro march.jpg");
  });

  it("falls back to the date and message id when there is no filename and no caption", () => {
    const intent = { kind: "file", fileId: "f3", fileName: undefined, mimeType: "image/jpeg", compressedPhoto: true } as const;
    expect(fileDocumentName({ intent, caption: undefined, messageId: 42, now: new Date("2026-09-18T00:00:00Z") })).toBe("telegram-20260918-42.jpg");
  });

  it("names a saved link from the page title", () => {
    expect(linkDocumentName({ title: "A Long Article About Kettles", url: "https://example.com/kettles" })).toBe(
      "A Long Article About Kettles.txt",
    );
  });

  it("names a saved link from the hostname when the page has no title", () => {
    expect(linkDocumentName({ title: "", url: "https://example.com/kettles" })).toBe("example.com.txt");
  });

  it("names a saved link something reasonable even for an unparseable url", () => {
    expect(linkDocumentName({ title: "", url: "not a url" })).toBe("Saved link.txt");
  });

  it("truncates a very long page title", () => {
    const long = "x".repeat(100);
    expect(linkDocumentName({ title: long, url: "https://example.com/" })).toBe(`${long.slice(0, 80)}....txt`);
  });

  it("keeps the source url as the document's first line", () => {
    expect(linkDocumentBody({ url: "https://example.com/kettles", text: "Kettles boil fast." })).toBe(
      "https://example.com/kettles\n\nKettles boil fast.",
    );
  });

  it("names the category and tags in the finished reply", () => {
    const reply = finishedDocumentReply({
      name: "Kettle receipt.pdf",
      categoryPath: "Finance / Receipts",
      tagNames: ["appliance", "warranty"],
      documentUrl: "https://app.example.com/documents/doc_1",
      ruleFailed: false,
      summaryFailed: false,
    });
    expect(reply).toContain('"Kettle receipt.pdf"');
    expect(reply).toContain("Finance / Receipts");
    expect(reply).toContain("appliance, warranty");
    expect(reply).toContain("https://app.example.com/documents/doc_1");
  });

  it("still names the document when it has no category or tags", () => {
    const reply = finishedDocumentReply({
      name: "note.txt",
      categoryPath: null,
      tagNames: [],
      documentUrl: "https://app.example.com/documents/doc_2",
      ruleFailed: false,
      summaryFailed: false,
    });
    expect(reply).toBe('Filed "note.txt". https://app.example.com/documents/doc_2');
  });

  it("says sorting failed by name when the rules stage did not finish", () => {
    const reply = finishedDocumentReply({
      name: "unsortable.txt",
      categoryPath: null,
      tagNames: [],
      documentUrl: "https://app.example.com/documents/doc_3",
      ruleFailed: true,
      summaryFailed: false,
    });
    expect(reply).toMatch(/sorting failed/i);
    expect(reply).toContain("unsortable.txt");
  });

  it("says both stages failed when neither finished cleanly", () => {
    const reply = finishedDocumentReply({
      name: "broken.txt",
      categoryPath: null,
      tagNames: [],
      documentUrl: "https://app.example.com/documents/doc_4",
      ruleFailed: true,
      summaryFailed: true,
    });
    expect(reply).toMatch(/summarizing and sorting both failed/i);
  });
});
