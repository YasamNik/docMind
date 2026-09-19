import { describe, expect, it } from "vitest";
import type { TelegramUpdate } from "./telegram.schemas.js";
import {
  compressedPhotoNotice,
  duplicateReply,
  fileDocumentName,
  fileTooLargeReply,
  finishedDocumentReply,
  intentOf,
  linkDocumentBody,
  linkDocumentName,
  newPairingCode,
  pairingSucceededReply,
  receivedReply,
  textDocumentName,
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
    expect(intentOf(notWholeMessage, { paired: true })).toEqual({ kind: "text", text: partiallyLinked });
  });

  it("reads any other text as a note", () => {
    const update = baseUpdate({
      message_id: 15,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "Remember to renew the lease by Friday.",
    });

    expect(intentOf(update, { paired: true })).toEqual({ kind: "text", text: "Remember to renew the lease by Friday." });
  });

  it("reads text as a pairing code only while unpaired", () => {
    const update = baseUpdate({
      message_id: 16,
      from: { id: 111, first_name: "Alex" },
      chat: { id: 111 },
      text: "vwx234",
    });

    expect(intentOf(update, { paired: false })).toEqual({ kind: "pairing", code: "VWX234" });
    expect(intentOf(update, { paired: true })).toEqual({ kind: "text", text: "vwx234" });
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

  it("titles a text note from its first line, truncated", () => {
    expect(textDocumentName("Remember to renew the lease by Friday.")).toBe("Remember to renew the lease by Friday..txt");
    const long = "x".repeat(80);
    expect(textDocumentName(`${long}\nsecond line`)).toBe(`${long.slice(0, 60)}....txt`);
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
