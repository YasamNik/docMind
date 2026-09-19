import type { AddressObject, Attachment, ParsedMail } from "mailparser";
import { sanitizeFilename } from "../documents/documents.models.js";

// Turns mailparser's parsed output into what the intake loop should file: the mail
// itself as one document, its worthwhile attachments as their own. No IO here:
// fetching the mail over IMAP and moving it to Done or Failed happen in
// email.usecases.ts. This module is informed by the shape of telegram.models.ts,
// which does the same "external input to intent" job for a chat message.

const MAX_SUBJECT_LENGTH = 80;
const SMALL_IMAGE_SKIP_BYTES = 10 * 1024;

function addressLine(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.map((address) => address.text).filter(Boolean).join(", ");
  return value.text;
}

// The sender, the recipients and the date live in the mail's own text, not only in
// its headers, so search and chat can answer a question like "who sent me the March
// invoice" without a separate index over headers.
function mailHeaderText(parsed: ParsedMail): string {
  const lines: string[] = [];
  const from = addressLine(parsed.from);
  if (from) lines.push(`From: ${from}`);
  const to = addressLine(parsed.to);
  if (to) lines.push(`To: ${to}`);
  const cc = addressLine(parsed.cc);
  if (cc) lines.push(`Cc: ${cc}`);
  if (parsed.date) lines.push(`Date: ${parsed.date.toISOString()}`);
  return lines.join("\n");
}

// Confirmed against the html-only and attachment-with-note fixtures: mailparser
// itself already prefers a genuine text/plain part and falls back to a body
// converted from html when a mail has none. This only reads what it already worked
// out, and covers the one case it leaves empty: a mail with no text and no html.
function mailBodyText(parsed: ParsedMail): string {
  return parsed.text?.trim() ?? "";
}

function mailDocumentName(parsed: Pick<ParsedMail, "subject" | "date">): string {
  const subject = parsed.subject?.trim();
  if (subject) {
    const short = subject.length > MAX_SUBJECT_LENGTH ? `${subject.slice(0, MAX_SUBJECT_LENGTH).trimEnd()}...` : subject;
    return `${short}.txt`;
  }
  if (parsed.date) return `No subject ${parsed.date.toISOString().slice(0, 10)}.txt`;
  return "No subject.txt";
}

// True for a signature logo or similar decoration a mail client stitched into its
// own html, and for any image small enough that it is almost certainly decoration
// rather than a document, checked independently of disposition. Everything else is
// kept on purpose: a missing invoice is worse than a stray logo.
function isNoiseAttachment(attachment: Attachment, html: string | false): boolean {
  const isImage = /^image\//i.test(attachment.contentType);
  if (isImage && attachment.size < SMALL_IMAGE_SKIP_BYTES) return true;

  const isInline = attachment.contentDisposition === "inline";
  const referencedByCid = Boolean(attachment.cid) && typeof html === "string" && html.includes(`cid:${attachment.cid}`);
  return isInline && referencedByCid;
}

export function documentsFromMail(parsed: ParsedMail): {
  mail: { name: string; text: string };
  attachments: { name: string; mimeType: string; content: Buffer }[];
} {
  const header = mailHeaderText(parsed);
  const body = mailBodyText(parsed);
  const text = header ? `${header}\n\n${body}` : body;

  const attachments = parsed.attachments
    .filter((attachment) => !isNoiseAttachment(attachment, parsed.html))
    .map((attachment) => ({
      name: sanitizeFilename(attachment.filename?.trim() || "attachment"),
      mimeType: attachment.contentType,
      content: attachment.content,
    }));

  return { mail: { name: mailDocumentName(parsed), text }, attachments };
}
