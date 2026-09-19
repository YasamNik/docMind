# Email intake implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a mail into a watched folder and have it, and every attachment it carries,
land in DocMind as documents, sorted, with the mail moved to Done so it never ingests twice.

**Architecture:** An email module owning a loop in the shape the telegram module
established: it re-reads its settings each cycle, connects over IMAP, takes a bounded batch
from the watched folder, turns each message into documents through the existing upload path,
and moves the message to Done. Attachments become their own documents pointing at the mail's
document through a new `parentDocumentId`.

**Tech Stack:** `imapflow` for the protocol, `mailparser` for MIME, valibot, vitest. MIME is
decades of encodings and nested multiparts; parsing it by hand would be the bug factory of
this whole feature.

**Spec:** `docs/superpowers/specs/2026-09-19-email-intake-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Module file roles: pure logic in `*.models.ts`, orchestration in `*.usecases.ts`, Hono
  only in `*.routes.ts`, Drizzle only in a repository. Every boundary parsed with valibot.
- `email.imap.password` is `secret: true`. It never appears in a log line, an error
  message, or an API response. An IMAP error often echoes the command it failed on, so
  errors must be rebuilt rather than forwarded.
- Task 1 changes a `*.tables.ts` file and MUST generate its migration in the same task, per
  `.claude/rules/schema-changes.md`. The column was approved by the user on 2026-09-18. No
  other task may touch a table.
- No test may open a network connection or need a mailbox. The loop takes its IMAP client
  as a dependency.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

## Lessons carried from the Telegram review, which this plan must not repeat

These are not theoretical. Each one was a real bug found in the feature this plan copies.

1. **One bad message must never stop the folder.** A failing mail is retried a bounded
   number of times and then moved to Failed. Task 4.
2. **A loop must be bounded everywhere it waits.** Connect, command and read all get
   timeouts, and `stop()` gives up after a deadline. Task 4.
3. **Do not close a connection before reading what it fetched.** Attachments stream from an
   open IMAP connection into storage; the connection closes after the last byte, not after
   the fetch call returns. Task 4.
4. **A test that injects a fake must not be the only test.** The link fetcher passed
   entirely on mocks while the real path was broken. Task 3 parses real MIME fixtures, not
   hand-built objects.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/documents/documents.tables.ts` | `parentDocumentId` |
| `apps/server/drizzle/0015_*.sql` | its migration, generated |
| `apps/server/src/modules/email/email.settings.ts` | the nine settings |
| `apps/server/src/modules/email/email.models.ts` | a parsed mail to documents, pure |
| `apps/server/src/modules/email/email.client.ts` | imapflow wrapped in a narrow interface |
| `apps/server/src/modules/email/email.usecases.ts` | the loop, intake, move to Done or Failed |
| `apps/server/src/modules/email/email.routes.ts` | test the connection |
| `apps/client/src/pages/settings/EmailTab.tsx` | settings, Test, setup guide |

---

### Task 1: The parent link

**Files:**
- Modify: `apps/server/src/modules/documents/documents.tables.ts`
- Create: `apps/server/drizzle/0015_*.sql` and its snapshot, by generation
- Modify: `apps/server/src/modules/documents/documents.usecases.ts` (`upload`)
- Modify: `apps/server/src/modules/documents/documents.repository.ts` (the list projection)
- Test: `apps/server/src/modules/documents/documents.usecases.test.ts`

**Interfaces:**
- Produces: `documents.parentDocumentId`, nullable, referencing `documents(id)` with
  `on delete cascade`. `upload` accepts an optional `parentDocumentId`. Task 4 passes it.

**Watch out:** the `source` column in migration 0014 needed adding to the repository's
explicit `listColumns` projection or typecheck failed. This column will need the same.

- [x] **Step 1: Write the failing test**

```ts
  it("links an attachment to the mail it arrived in, and deletes it with the mail", async () => {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const { document: attachment } = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["pdf"]),
      source: "email", parentDocumentId: mail.id,
    });

    expect((await documents.get({ userId, documentId: attachment.id })).parentDocumentId).toBe(mail.id);

    await documents.purge({ userId, documentId: mail.id });
    await expect(documents.get({ userId, documentId: attachment.id })).rejects.toMatchObject({ code: "documents.not_found" });
  });
```

The second half is the point of the cascade: deleting the mail takes its attachments with
it, because that is what a person means by deleting the email.

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server exec vitest run documents.usecases`

- [x] **Step 3: Add the column**

```ts
    // The mail an attachment arrived in. Cascade, because deleting the email should take
    // the invoice that came with it rather than leaving an orphan with no context.
    parentDocumentId: text("parent_document_id").references((): AnySQLiteColumn => documentsTable.id, { onDelete: "cascade" }),
```

A self reference needs the `AnySQLiteColumn` annotation or TypeScript cannot infer the
type.

**What actually happened, for the next reader.** This plan assumed SQLite cannot add a
foreign key with `ALTER TABLE` and that drizzle-kit would rebuild the table. It does not:
the drizzle-kit version in use here emits a one line
`ALTER TABLE documents ADD parent_document_id text REFERENCES documents(id);`, because
SQLite does allow `ADD COLUMN ... REFERENCES` when the new column is nullable with no
non-null default. Verified on a disposable copy of the live database: all 14 rows and
every existing column survived, `PRAGMA foreign_key_check` reported no violations. On
that axis the one line ALTER is actually safer than a rebuild would have been.

The real problem was different: that ALTER path drops the `ON DELETE CASCADE` clause
even though `documents.tables.ts` declares it, and the migration's own snapshot metadata
still records `onDelete: cascade` correctly. Confirmed the break through the app's real
migration pipeline (`createDatabase` + `runMigrations`, the same path `index.ts` and
`createTestDatabase` use): inserting a parent and a child and then deleting the parent
raised `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` instead of cascading, and both
rows survived. A first pass at this task stopped here and reported it rather than
guessing at a fix, per this plan's own instruction.

The resolution, on explicit instruction after that report: keep the one line ALTER
(safest shape for a live database with real rows in it; a forced rebuild would trade a
verified-safe migration for a riskier one just to satisfy the generator) and hand-edit
the generated SQL to add `ON DELETE CASCADE` back, with a comment in the migration file
explaining why, so nobody "fixes" it back to what drizzle-kit produced. Because the
snapshot already records the cascade, a later `db:generate` sees no drift and will not
touch the file. Raw SQL is explicitly allowed in migrations per `CLAUDE.md`.

Also added defense in depth in the application: `documents.purge()` now collects a
document's full subtree through `parentDocumentId` and deletes children before the
parent explicitly, rather than relying only on the database's `ON DELETE CASCADE`. The
cascade depends on `PRAGMA foreign_keys` being on for the connection that runs the
delete, a property of how the database was opened rather than of the data, so the
application no longer depends on that alone. Covered by two tests: one exercising
`documents.purge()` (the application path), one deleting the parent row directly through
the repository, bypassing `purge()`, to prove the schema's own cascade also holds.

- [x] **Step 4: Generate the migration, in this task**

```bash
cd apps/server && pnpm db:generate --name add_parent_document_id
```

Then hand-edit `apps/server/drizzle/0015_add_parent_document_id.sql` to add
`ON DELETE CASCADE` and the comment explaining why, as above. Verified again afterward
on a disposable copy of the live database: 14 rows before and after, `PRAGMA
foreign_key_check` clean, and a real cascade delete against one of the 14 actual rows
removed a synthetic child correctly.

- [x] **Step 5: Thread it through upload and the list projection, then run**

Run: `pnpm --filter @docmind/server exec vitest run documents` and `pnpm typecheck`

- [x] **Step 6: Commit**

```bash
git add apps/server/src/modules/documents apps/server/drizzle
git commit -m "feat(server): link a document to the one it arrived in"
```

---

### Task 2: Settings and the IMAP client

**Files:**
- Create: `apps/server/src/modules/email/email.settings.ts`
- Create: `apps/server/src/modules/email/email.client.ts` and its test
- Modify: `apps/server/src/modules/settings/settings.definitions.ts`
- Modify: `apps/server/package.json` (`imapflow`, `mailparser`)

**Interfaces:**
- Produces: the nine settings from the spec, and
  `createImapClient(config)` with `listFolder`, `fetchMessage`, `moveMessage`,
  `ensureFolder`, `close`. Task 4 uses all of them. The interface is narrow on purpose so a
  fake in tests is a few lines rather than an imapflow emulator.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter @docmind/server add imapflow mailparser
pnpm --filter @docmind/server add -D @types/mailparser
```

- [ ] **Step 2: Write the settings**

The nine keys from the spec's table, `password` secret, `lastError` internal, registered
beside the others.

- [ ] **Step 3: Write the failing client tests**

Against a fake imapflow, never a server. Assert that a connection failure throws an error
carrying the host and the reason but never the password, the same rule the Telegram client
follows for its token.

- [ ] **Step 4: Implement and commit**

```bash
git add apps/server
git commit -m "feat(server): imap settings and a narrow client"
```

---

### Task 3: A mail becomes documents

**Files:**
- Create: `apps/server/src/modules/email/email.models.ts` and its test
- Create: `apps/server/src/modules/email/fixtures/` with real `.eml` files

**Interfaces:**
- Produces: `documentsFromMail(parsed): { mail: { name, text }, attachments: { name, mimeType, content }[] }`,
  pure, taking mailparser's output.

**The fixtures are the point of this task.** Build them as real `.eml` files and parse them
with the real mailparser, rather than hand-building the object mailparser is assumed to
return. The Telegram link fetcher passed every test while being broken in production
precisely because the tests only ever met a fake.

- [ ] **Step 1: Write the fixtures and the failing tests**

One fixture each: plain text only; HTML only; an attachment plus a covering note; an inline
signature logo that must be skipped; a nested multipart; a non-UTF8 charset; an empty
subject; a filename with a slash in it.

```ts
it("names the document from the subject, and falls back when there is none", async () => { /* ... */ });
it("prefers the plain text part, and converts html when that is all there is", async () => { /* ... */ });
it("keeps the sender, the recipients and the date in the text", async () => { /* ... */ });
it("returns an attachment as its own document", async () => { /* ... */ });
it("skips an inline logo referenced by cid, and anything under ten kilobytes that is an image", async () => { /* ... */ });
it("reads a windows-1252 body without mojibake", async () => { /* ... */ });
it("refuses to let an attachment filename escape its own name", async () => {
  // "../../etc/passwd" must not survive as a path
});
```

- [ ] **Step 2: Run, watch them fail, implement, run again**

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/modules/email
git commit -m "feat(server): turn a parsed mail into documents"
```

---

### Task 4: The loop

**Files:**
- Create: `apps/server/src/modules/email/email.usecases.ts` and its test
- Modify: `apps/server/src/server.ts`, `apps/server/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 3.
- Produces: `createEmailService({ settingsService, documentsService, getUserId, clientFactory? })`
  with `runOnce()`, `start()`, `stop()`, following the telegram service exactly.

- [ ] **Step 1: Write the failing tests**

```ts
it("does nothing while no host or password is configured", async () => { /* ... */ });
it("turns a mail and its attachment into two linked documents", async () => { /* ... */ });
it("moves a handled message to the Done folder", async () => { /* ... */ });
it("does not handle the same message twice", async () => { /* ... */ });
it("creates the Done and Failed folders when they do not exist", async () => { /* ... */ });
it("retries a failing message a bounded number of times, then moves it to Failed", async () => { /* ... */ });
it("keeps handling later messages after an earlier one fails for good", async () => { /* ... */ });
it("takes a bounded batch, so a folder of thousands does not stall the process", async () => { /* ... */ });
it("backs off after a connection failure and recovers", async () => { /* ... */ });
it("returns from stop() even when a cycle is stuck", async () => { /* ... */ });
```

Seven of those ten exist because the Telegram review found the same class of bug. Write
them first.

- [ ] **Step 2: Run, watch them fail, implement**

Upload the mail first, then each attachment with `parentDocumentId` set to it, then move
the message. Commit the documents before the move, so a crash between them leaves the
message to be handled again, and rely on content-hash dedupe to make that safe.

- [ ] **Step 3: Start it from index.ts**

Beside the job runner and the telegram loop, not inside `createServer`, for the reason the
telegram module documents: test files construct servers without tearing them down.

- [ ] **Step 4: Run everything and commit**

```bash
git add apps/server/src
git commit -m "feat(server): watch a mailbox folder and file what arrives"
```

---

### Task 5: The Email settings page

**Files:**
- Create: `apps/server/src/modules/email/email.routes.ts` and its test
- Create: `apps/client/src/lib/email-api.ts`
- Create: `apps/client/src/pages/settings/EmailTab.tsx` and its test
- Modify: `apps/client/src/pages/settings/SettingsPage.tsx`, `apps/server/src/server.ts`

**Interfaces:**
- Produces: `POST /api/email/test` returning `{ ok, message }`, which connects, opens the
  folder, and reports how many messages are waiting.

- [ ] **Step 1: Write the failing tests, both sides**

The route never returns the password. The tab shows the settings, a Test button, and the
setup guide.

- [ ] **Step 2: Implement**

The guide covers what people actually get wrong: that Gmail and most providers need an app
password rather than the account password, where to create one, that the watched folder
must exist first, and that DocMind only ever reads that one folder and moves messages out
of it. Reuse `GuideCard`.

Secrets follow the project rule: masked with a Replace action, never prefilled. The
Telegram tab shipped without that and had to be fixed; do not repeat it.

- [ ] **Step 3: Run everything and commit**

```bash
git add apps/server/src apps/client/src
git commit -m "feat: an email settings page with a connection test"
```

---

## Self-review

**Spec coverage.** Spec section 1 is Task 1, section 2 is Tasks 2 and 4, section 3 is Task
3, section 4 is Task 4, section 5 is Tasks 2 and 5, section 7 is spread across all of them.

**What this plan does differently from the Telegram plan, deliberately.** The failure
handling, the bounded batch, the bounded stop and the real-fixture tests are all in the plan
from the start rather than added by a review afterwards. Task 4's test list is longer than
its feature list for that reason.

**The one risk worth restating.** Task 1's foreign key forces SQLite to rebuild the
documents table. The generated migration must be read before it is committed, and the user
is running a live dev server against this database.
