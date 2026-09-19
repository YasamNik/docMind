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

// A refusal from the link guard already reads like a sentence a person can act on,
// so the chat reply is just that reason with no extra framing added around it.

// A fetched page keeps its own title when it has one. A page readability could make
// nothing of, such as a bare listing, still gets a name from its own hostname rather
// than a blank one.
export function linkDocumentName({ title, url }: { title: string; url: string }): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    const short = trimmedTitle.length > 80 ? `${trimmedTitle.slice(0, 80).trimEnd()}...` : trimmedTitle;
    return `${short}.txt`;
  }
  try {
    return `${new URL(url).hostname}.txt`;
  } catch {
    return "Saved link.txt";
  }
}

// The source url is kept as the document's own first line, not in a new column, so
// search and chat can cite where a saved link came from with no schema change.
export function linkDocumentBody({ url, text }: { url: string; text: string }): string {
  return `${url}\n\n${text}`;
}

// Extensions this module ever actually needs to guess: a photo always reports
// image/jpeg, and a forwarded file carries whatever mime type the sender's own client
// attached. Anything else is left without an extension rather than guessed wrong.
const KNOWN_FILE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

function guessedExtension(mimeType: string | undefined): string {
  if (!mimeType) return "";
  return KNOWN_FILE_EXTENSIONS[mimeType] ?? "";
}

function withGuessedExtension(base: string, mimeType: string | undefined): string {
  const ext = guessedExtension(mimeType);
  if (!ext || base.toLowerCase().endsWith(ext)) return base;
  return `${base}${ext}`;
}

// A photo or a forwarded file carries no filename of its own. A caption someone
// actually typed, "hydro march", makes a far better name than a timestamp, so it wins
// whenever Telegram gave nothing better. documentsService.upload sanitizes whatever
// name it is handed, so this only has to pick a reasonable one.
export function fileDocumentName({
  intent,
  caption,
  messageId,
  now,
}: {
  intent: Extract<TelegramIntent, { kind: "file" }>;
  caption: string | undefined;
  messageId: number;
  now: Date;
}): string {
  if (intent.fileName) return intent.fileName;
  const trimmedCaption = caption?.trim();
  if (trimmedCaption) return withGuessedExtension(trimmedCaption, intent.mimeType);
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `telegram-${stamp}-${messageId}${guessedExtension(intent.mimeType)}`;
}

// A text note has no filename at all, so it is titled from its own first line until
// the summary model retitles it, the same gap a nameless browser upload would have.
export function textDocumentName(text: string): string {
  const firstLine = text.split(/\r?\n/)[0]!.trim();
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}...` : firstLine;
  return `${short || "Note"}.txt`;
}
