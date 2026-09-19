import { randomInt } from "node:crypto";
import type { TelegramMessage, TelegramMessageEntity, TelegramUpdate } from "./telegram.schemas.js";

// Pure mapping from a validated Telegram update to what the loop should do about it.
// No IO here: pairing comparisons, uploads and replies all happen in telegram.usecases.ts.

type TelegramAttachment = NonNullable<TelegramMessage["document"]>;
type TelegramPhotoSize = NonNullable<TelegramMessage["photo"]>[number];

export type TelegramIntent =
  | { kind: "pairing"; code: string }
  | { kind: "file"; fileId: string; fileName: string | undefined; mimeType: string | undefined; compressedPhoto: boolean }
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "ignore" };

function fileIntentFromAttachment(attachment: TelegramAttachment): TelegramIntent {
  return {
    kind: "file",
    fileId: attachment.file_id,
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    compressedPhoto: false,
  };
}

function photoArea(size: TelegramPhotoSize): number {
  return size.width * size.height;
}

function fileIntentFromPhoto(sizes: TelegramPhotoSize[]): TelegramIntent {
  const largest = sizes.reduce((best, size) => (photoArea(size) > photoArea(best) ? size : best));
  return {
    kind: "file",
    fileId: largest.file_id,
    fileName: undefined,
    mimeType: "image/jpeg",
    compressedPhoto: true,
  };
}

// Where the trimmed text starts and ends within the raw text, in the same units Telegram
// counts entity offsets in, so a link entity can be checked against it directly.
function trimmedRange(text: string): { start: number; end: number } {
  return { start: text.length - text.trimStart().length, end: text.trimEnd().length };
}

function urlFromEntity(text: string, entity: TelegramMessageEntity): string | null {
  if (entity.type === "text_link") return entity.url ?? null;
  if (entity.type === "url") return text.slice(entity.offset, entity.offset + entity.length);
  return null;
}

// A message is a link only when Telegram's own parser marked the whole trimmed message as
// one url or text_link entity. This reads entities rather than matching a regex, so DocMind
// never disagrees with what the user saw highlighted in their own Telegram client.
function wholeMessageLinkUrl(text: string, entities: TelegramMessageEntity[] | undefined): string | null {
  if (!entities || entities.length !== 1) return null;
  const entity = entities[0]!;
  const { start, end } = trimmedRange(text);
  if (entity.offset !== start || entity.offset + entity.length !== end) return null;
  return urlFromEntity(text, entity);
}

export function intentOf(update: TelegramUpdate, { paired }: { paired: boolean }): TelegramIntent {
  const message = update.message;
  if (!message) return { kind: "ignore" };

  if (message.document) return fileIntentFromAttachment(message.document);
  if (message.photo && message.photo.length > 0) return fileIntentFromPhoto(message.photo);
  if (message.video) return fileIntentFromAttachment(message.video);
  if (message.audio) return fileIntentFromAttachment(message.audio);

  const text = message.text;
  if (!text || text.trim().length === 0) return { kind: "ignore" };

  const linkUrl = wholeMessageLinkUrl(text, message.entities);
  if (linkUrl) return { kind: "link", url: linkUrl };

  if (!paired) return { kind: "pairing", code: text.trim().toUpperCase() };

  return { kind: "text", text: text.trim() };
}

// Excludes characters that are easy to misread or mistype: I, O, 0 and 1.
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 6;

export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  return code;
}

export function pairingSucceededReply(): string {
  return "You're paired. Send a file, a photo or a note and I'll add it to DocMind.";
}

export function receivedReply(label: string): string {
  return `Got it. Added "${label}" to DocMind.`;
}

export function duplicateReply(label: string): string {
  return `I already have "${label}", so I didn't add it again.`;
}

export function fileTooLargeReply(): string {
  return "That file is bigger than the 20 MB limit Telegram lets a bot download. Try adding it from the app instead.";
}

export function compressedPhotoNotice(): string {
  return "Heads up, Telegram compresses photos, which can hurt text recognition. Send it as a file instead of a photo to keep the original quality.";
}

export function linkNotSupportedReply(): string {
  return "Links aren't supported yet. Send the file itself or a note instead.";
}
