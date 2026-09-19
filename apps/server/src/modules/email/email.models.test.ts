import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { documentsFromMail } from "./email.models.js";

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
