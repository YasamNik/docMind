import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { createError } from "../../shared/errors/errors.js";
import { classifyEmailFailure, documentsFromMail, resolveEmailMode } from "./email.models.js";

// These fixtures are real .eml files parsed with the real mailparser, not objects
// this test assumes mailparser would return. That is the point of this module: the
// telegram link fetcher passed every test it had while broken in production,
// because its tests only ever met a fake.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "fixtures");

async function parseFixture(name: string) {
  const raw = await readFile(join(FIXTURES_DIR, name));
  return simpleParser(raw, { keepCidLinks: true });
}

describe("documentsFromMail", () => {
  it("names the document from the subject, and falls back when there is none", async () => {
    const withSubject = await parseFixture("plain-text-only.eml");
    expect(documentsFromMail(withSubject).mail.name).toBe("Quarterly report ready.txt");

    const noSubject = await parseFixture("empty-subject.eml");
    const fallbackName = documentsFromMail(noSubject).mail.name;
    expect(fallbackName).toMatch(/^No subject/);
    expect(fallbackName.endsWith(".txt")).toBe(true);
  });

  it("prefers the plain text part, and converts html when that is all there is", async () => {
    const withBoth = await parseFixture("attachment-with-note.eml");
    const bothText = documentsFromMail(withBoth).mail.text;
    expect(bothText).toContain("Please find the March invoice attached. Plain version.");
    expect(bothText).not.toContain("HTML version");
    expect(bothText).not.toContain("<strong>");
    expect(bothText).not.toContain("<p>");

    const htmlOnly = await parseFixture("html-only.eml");
    const htmlText = documentsFromMail(htmlOnly).mail.text;
    expect(htmlText).toContain("This message only has an HTML body.");
    expect(htmlText).toContain("Second paragraph with");
    expect(htmlText).not.toContain("<p>");
  });

  it("keeps the sender, the recipients and the date in the text", async () => {
    const parsed = await parseFixture("plain-text-only.eml");
    const { text } = documentsFromMail(parsed).mail;
    expect(text).toContain("alice@example.com");
    expect(text).toContain("bob@example.com");
    expect(text).toContain("2026-01-05");
  });

  it("returns an attachment as its own document", async () => {
    const parsed = await parseFixture("attachment-with-note.eml");
    const { attachments } = documentsFromMail(parsed);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "invoice.pdf", mimeType: "application/pdf" });
    expect(attachments[0]!.content.toString("utf-8")).toBe("PDF-ISH-CONTENT-MARKER-INVOICE");
  });

  it("skips an inline logo referenced by cid, and anything under ten kilobytes that is an image", async () => {
    const parsed = await parseFixture("inline-logo.eml");
    const { attachments } = documentsFromMail(parsed);
    const names = attachments.map((attachment) => attachment.name);

    // The inline logo is skipped because it is both inline and referenced by cid.
    expect(names).not.toContain("logo.png");
    // The tiny image is skipped on size alone, even though nothing marks it inline.
    expect(names).not.toContain("tiny.png");
    // A non-image attachment is always kept, whatever its size.
    expect(names).toContain("report.pdf");
    // A bigger image that is not decoration is kept too: images are not blanket skipped.
    expect(names).toContain("photo.jpg");
    expect(names).toHaveLength(2);
  });

  it("extracts the body and an attachment from a deeply nested multipart structure", async () => {
    const parsed = await parseFixture("nested-multipart.eml");
    const { mail, attachments } = documentsFromMail(parsed);
    expect(mail.text).toContain("Nested plain body marker.");
    expect(attachments.map((attachment) => attachment.name)).toEqual(["deep-invoice.pdf"]);
  });

  it("reads a windows-1252 body without mojibake", async () => {
    const parsed = await parseFixture("windows-1252.eml");
    const { text } = documentsFromMail(parsed).mail;
    expect(text).toContain("café");
    expect(text).toContain("“DocMind”");
    expect(text).toContain("€19.99");
    expect(text).toContain("— thanks");
  });

  it("refuses to let an attachment filename escape its own name", async () => {
    const parsed = await parseFixture("escaping-filename.eml");
    const { attachments } = documentsFromMail(parsed);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toBe("passwd");
    expect(attachments[0]!.name).not.toContain("/");
    expect(attachments[0]!.name).not.toContain("..");
  });

  it("falls back to a plain name for an attachment with no filename at all", async () => {
    const parsed = await parseFixture("no-filename-attachment.eml");
    const { attachments } = documentsFromMail(parsed);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toBe("attachment");
    expect(attachments[0]!.content.toString("utf-8")).toBe("NO-FILENAME-ATTACHMENT-MARKER");
  });

  it("keeps two attachments that share the same filename as two separate documents", async () => {
    const parsed = await parseFixture("duplicate-filenames.eml");
    const { attachments } = documentsFromMail(parsed);
    expect(attachments).toHaveLength(2);
    expect(attachments.map((attachment) => attachment.name)).toEqual(["receipt.pdf", "receipt.pdf"]);
    expect(attachments[0]!.content.equals(attachments[1]!.content)).toBe(false);
  });
});

describe("resolveEmailMode", () => {
  it("resolves gmail when both the refresh token and the account email are set", () => {
    expect(resolveEmailMode({ gmailRefreshToken: "rt", gmailAccountEmail: "me@gmail.com" })).toBe("gmail");
  });

  it("resolves gmail over a configured app password when both are present", () => {
    expect(
      resolveEmailMode({ gmailRefreshToken: "rt", gmailAccountEmail: "me@gmail.com", imapHost: "imap.example.com", imapPassword: "pw" }),
    ).toBe("gmail");
  });

  it("does not resolve gmail with only the refresh token set", () => {
    expect(resolveEmailMode({ gmailRefreshToken: "rt" })).toBe("unconfigured");
  });

  it("does not resolve gmail with only the account email set", () => {
    expect(resolveEmailMode({ gmailAccountEmail: "me@gmail.com" })).toBe("unconfigured");
  });

  it("falls back to password mode when gmail is half configured and a password is set", () => {
    expect(resolveEmailMode({ gmailRefreshToken: "rt", imapHost: "imap.example.com", imapPassword: "pw" })).toBe("password");
  });

  it("resolves password mode when host and password are set", () => {
    expect(resolveEmailMode({ imapHost: "imap.example.com", imapPassword: "pw" })).toBe("password");
  });

  it("does not resolve password mode with only the host set", () => {
    expect(resolveEmailMode({ imapHost: "imap.example.com" })).toBe("unconfigured");
  });

  it("does not resolve password mode with only the password set", () => {
    expect(resolveEmailMode({ imapPassword: "pw" })).toBe("unconfigured");
  });

  it("resolves unconfigured when nothing is set", () => {
    expect(resolveEmailMode({})).toBe("unconfigured");
  });
});

describe("classifyEmailFailure", () => {
  it("maps a revoked google grant to reauth_required", () => {
    const error = createError({ code: "google.reauth_required", message: "Google access has expired or been revoked.", status: 401 });
    expect(classifyEmailFailure(error)).toEqual({ code: "reauth_required", message: expect.any(String) });
  });

  it("maps a generic google auth failure to auth_failed", () => {
    const error = createError({ code: "google.auth_failed", message: "Could not mint a Google access token.", status: 502 });
    expect(classifyEmailFailure(error).code).toBe("auth_failed");
  });

  it("maps an imap authentication failure to auth_failed", () => {
    const error = createError({ code: "email.imap_error", message: "IMAP connect to imap.example.com: authentication failed", status: 502 });
    expect(classifyEmailFailure(error).code).toBe("auth_failed");
  });

  it("maps a missing watched folder to folder_missing", () => {
    const error = createError({ code: "email.imap_error", message: "IMAP mailboxOpen to imap.example.com: the folder does not exist", status: 502 });
    expect(classifyEmailFailure(error).code).toBe("folder_missing");
  });

  it("maps a host, refusal or timeout failure to network", () => {
    const host = createError({ code: "email.imap_error", message: "IMAP connect to typo.example.com: could not resolve the host", status: 502 });
    const refused = createError({ code: "email.imap_error", message: "IMAP connect to imap.example.com: the connection was refused", status: 502 });
    const timeout = createError({ code: "email.imap_error", message: "IMAP connect to imap.example.com: timed out", status: 502 });
    expect(classifyEmailFailure(host).code).toBe("network");
    expect(classifyEmailFailure(refused).code).toBe("network");
    expect(classifyEmailFailure(timeout).code).toBe("network");
  });

  it("maps anything else, including a plain Error, to unknown", () => {
    expect(classifyEmailFailure(new Error("smtp said: LOGIN user hunter2 failed")).code).toBe("unknown");
    expect(classifyEmailFailure("a string is not even an error").code).toBe("unknown");
  });

  it("never puts a raw error message in the classified message", () => {
    const secret = "hunter2-the-real-password";
    const error = new Error(`login failed for password ${secret}`);
    const classified = classifyEmailFailure(error);
    expect(classified.message).not.toContain(secret);
  });
});
