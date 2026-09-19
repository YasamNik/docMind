# Email intake

Date: 2026-09-19
Feature list item: #18 (Email intake).

## Why

Most documents worth keeping arrive by email: invoices, statements, tickets, contracts.
Today each one is a manual download and re-upload. A watched mailbox folder closes that
loop: forward or filter mail into it and the documents file themselves.

## What the user decided

Asked on 2026-09-18, answered the same day:

- **Attachments become their own documents, linked to the email.** The invoice PDF is
  searchable, taggable and sortable on its own, and you can still see the mail it arrived
  in. This needs one column, `parentDocumentId`, which the user approved in the same answer.
- **One watched folder decides what is taken.** You move or filter mail into it. No sender
  allowlist to maintain: moving a message is the decision.
- **Processed mail moves to a Done subfolder.** Visible in any mail client, auditable, and
  reprocessing is dragging a message back. Not a hidden IMAP keyword, not a database-only
  record that a restore could replay.

## Design

### 1. The second database change

```
parent_document_id text references documents(id) on delete cascade
```

Null for everything that exists and for everything not born of an attachment. An
attachment's document points at the email's document. The cascade matters: deleting the
email deletes its attachments, which is what a person means by deleting the email.

`source` already exists from Telegram intake and takes the value `email` here, which is
exactly why it was made general rather than Telegram-specific.

### 2. Transport

IMAP over TLS with an app password, using `imapflow` for the protocol and `mailparser` for
MIME. Both are the maintained standards for this in Node, and MIME is not something to
hand-roll: it is decades of encodings, nested multiparts and character sets.

The loop follows the shape Telegram established, for the same reasons: its own loop rather
than a jobs-table entry, re-reading its settings each cycle so saving a password starts it
and clearing one stops it, single instance, backoff on failure.

Each cycle connects, opens the watched folder, and handles what it finds. A persistent
IDLE connection would be more responsive, but a connect-per-cycle is far easier to reason
about when the network drops, and a minute of latency on an email is nothing. IDLE is a
later change if it ever matters.

### 3. What a message becomes

The email becomes one document: the subject as its name, the body as its text, and the
sender, recipients and date recorded in that text so search and chat can use them. The body
is taken from the `text/plain` part when there is one, and converted from HTML when there
is not.

Each attachment becomes its own document with `parentDocumentId` set to the email's, and
`source: 'email'`. Attachments go through the same upload path as everything else, so a PDF
gets extracted, summarized, given smart fields and sorted exactly as an uploaded PDF would.

**Not every attachment is a document.** A signature logo is not an invoice. Skipped:
anything marked `inline` and referenced by a `cid:` in the HTML body, and any image under
10 KB. Everything else is kept. This will occasionally keep something pointless, which is
the right direction to err: a missing invoice is worse than a stray logo.

### 4. Processed, and failed

A message that is handled moves to the Done subfolder. The move is what guarantees no
second ingest, and it happens after the documents are committed, so a crash between the two
leaves the message in place to be handled again. Re-handling is safe: the upload path
dedupes on content hash, so a repeated attachment resolves to the existing document.

A message that fails is retried on later cycles, but only a bounded number of times, then
moved to a Failed subfolder with the reason recorded on the server log. This is the lesson
from the Telegram review, where a single unprocessable update wedged the pipeline forever:
a folder full of mail must never be stopped by one malformed message.

### 5. Settings

| Key | Secret | Purpose |
|-----|--------|---------|
| `email.imap.host` | no | for example imap.gmail.com |
| `email.imap.port` | no | defaults to 993 |
| `email.imap.user` | no | the mailbox address |
| `email.imap.password` | yes | an app password, never the account password |
| `email.imap.folder` | no | watched folder, defaults to `DocMind` |
| `email.imap.doneFolder` | no | defaults to `DocMind/Done` |
| `email.imap.failedFolder` | no | defaults to `DocMind/Failed` |
| `email.imap.pollSeconds` | no | defaults to 60 |
| `email.imap.lastError` | internal | surfaced on the settings page |

A Test action connects, lists the folder and reports what it found, so a wrong host or a
password that is not an app password fails on the settings page rather than silently in a
loop.

The setup guide covers what people actually get wrong: that Gmail and most providers need
an app password rather than the account password, where to create one, and that the watched
folder must exist before it can be watched.

### 6. What this is not

- Not a mail client. DocMind reads one folder and moves messages out of it. It never
  deletes, never replies, never touches the inbox.
- Not Gmail OAuth. That is worth doing later through the same Google app as Drive, and it
  removes the app password entirely, but IMAP works for every provider today.
- No link fetching from email bodies. Mail is the most hostile input there is, and the link
  fetcher exists for messages a human deliberately sent the bot.

### 7. Testing

- The message-to-documents mapping is pure and unit tested against real MIME fixtures:
  plain text, HTML only, an attachment, an inline logo that must be skipped, a nested
  multipart, a non-UTF8 charset, an empty subject.
- The loop is tested against a fake IMAP client: a message becomes documents, is moved to
  Done, is not handled twice, a failing message is retried then moved to Failed, and a
  connection failure backs off and recovers.
- No test opens a network connection or needs a mailbox.

## Risks

- **An app password is full mailbox access.** It is stored encrypted like every other
  secret, but the guide should say plainly to create a dedicated one and revoke it if
  DocMind is ever retired.
- **A folder with thousands of messages** would be ingested in one go the first time it is
  pointed at. The cycle takes a bounded batch per pass so the first run spreads out rather
  than stalling the process or the model budget.
- **Attachment sizes.** A 50 MB attachment streams through the same upload path as any
  file, but a mailbox full of them would fill the storage driver quickly. The upload path's
  existing size cap applies unchanged.
