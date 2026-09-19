import type { AddressObject, Attachment, ParsedMail } from "mailparser";
import { isAppError } from "../../shared/errors/errors.js";
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

export type EmailMode = "gmail" | "password" | "unconfigured";

// Which credentials the loop connects with this cycle, resolved fresh from the
// settings values every time rather than cached, the same way the credentials
// themselves already are. Gmail wins when both a connection and an app password
// exist: connecting an account is a deliberate, recent act, while an app password is
// usually a leftover from before. A half configured Gmail connection, missing either
// the refresh token or the account email, counts as no connection at all.
export function resolveEmailMode({
  gmailRefreshToken,
  gmailAccountEmail,
  imapHost,
  imapPassword,
}: {
  gmailRefreshToken?: string;
  gmailAccountEmail?: string;
  imapHost?: string;
  imapPassword?: string;
}): EmailMode {
  if (gmailRefreshToken && gmailAccountEmail) return "gmail";
  if (imapHost && imapPassword) return "password";
  return "unconfigured";
}

export type EmailFailureCode = "reauth_required" | "auth_failed" | "folder_missing" | "network" | "unknown";
export type EmailFailure = { code: EmailFailureCode; message: string };

// The reason a cycle or a Test attempt failed, read back off email.client.ts's own
// rebuilt error the same narrow way imapFailureReason does in the usecases file.
const IMAP_REASON_CODES: Record<string, EmailFailureCode> = {
  "authentication failed": "auth_failed",
  "the folder does not exist": "folder_missing",
  "could not resolve the host": "network",
  "the connection was refused": "network",
  "timed out": "network",
};

const UNKNOWN_FAILURE: EmailFailure = { code: "unknown", message: "the mailbox could not be checked" };

// The one function that turns any failure from either family the intake cycle can
// throw, an imap error or a Google auth error, into a fixed code and a short curated
// message. Called from the loop's own catch and from testConnection, so the two can
// never disagree about what the reconnect banner should say. Reads only structured
// fields off an AppError, never an underlying message, response body or stack, which
// for a Google failure can carry the refresh token and for an imap failure can carry
// the password.
export function classifyEmailFailure(error: unknown): EmailFailure {
  if (isAppError(error)) {
    if (error.code === "google.reauth_required") {
      return { code: "reauth_required", message: "Gmail access has expired or been revoked. Reconnect the account." };
    }
    if (error.code === "google.auth_failed") {
      return { code: "auth_failed", message: "Could not sign in to Gmail." };
    }
    if (error.code === "email.imap_error") {
      const reason = error.message.split(": ").pop() ?? "";
      const code = IMAP_REASON_CODES[reason];
      if (code) return { code, message: reason };
    }
  }
  return UNKNOWN_FAILURE;
}
