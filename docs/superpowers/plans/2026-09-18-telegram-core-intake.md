# Telegram core intake implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a file, a photo or a note to your own Telegram bot and have it land in
DocMind, sorted, with the bot telling you it arrived.

**Architecture:** A telegram module owning a long polling loop in the shape of
`jobs.runner.ts`: it re-reads its token each cycle, asks Telegram for updates, validates
each one with valibot, maps it to an intent with a pure function, and streams files or
notes into the existing `documentsService.upload`. Pairing binds the bot to one Telegram
user id. Documents record where they came from through a new `source` column.

**Tech Stack:** Hono, Drizzle with libsql, valibot, vitest, the Telegram Bot API over
`fetch`. No Telegram SDK: the three calls needed (`getUpdates`, `getFile`, `sendMessage`)
are plain HTTPS and a library would be more surface than code.

**Spec:** `docs/superpowers/specs/2026-09-18-telegram-intake-design.md`

**This is plan 1 of 3.** Links (the fetch guard and readable text) and the second reply
(the notifier) are separate plans, per the spec's Delivery section. This plan ends with a
bot that accepts files, photos and notes and confirms each one.

## Global Constraints

- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Module file roles: pure logic in `*.models.ts`, orchestration in `*.usecases.ts`, Hono
  only in `*.routes.ts`, Drizzle only in `*.repository.ts`. Every boundary parsed with
  valibot, and a raw Telegram update is a boundary.
- `telegram.botToken` is `secret: true`. It never appears in a log line, an error message,
  a URL that gets logged, or an API response. Telegram puts the token in the request path,
  so any logged URL must be redacted.
- Every other telegram setting is `internal: true` so the generated settings form does not
  render a pairing code as an editable field.
- Task 1 changes a `*.tables.ts` file and MUST generate the migration in the same task,
  per `.claude/rules/schema-changes.md`. The column was approved by the user on
  2026-09-18. No other task may touch a table.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
  `pnpm --filter @docmind/server test -- <pattern>` does not filter.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/documents/documents.tables.ts` | the `source` column |
| `apps/server/drizzle/0014_add_document_source.sql` | its migration, generated not written |
| `apps/server/src/modules/documents/documents.usecases.ts` | upload records the source |
| `apps/server/src/modules/telegram/telegram.schemas.ts` | valibot over the raw update |
| `apps/server/src/modules/telegram/telegram.models.ts` | update to intent, reply text, pairing code |
| `apps/server/src/modules/telegram/telegram.client.ts` | getUpdates, getFile, sendMessage |
| `apps/server/src/modules/telegram/telegram.usecases.ts` | the loop and the intake |
| `apps/server/src/modules/telegram/telegram.settings.ts` | the five settings |
| `apps/server/src/modules/telegram/telegram.routes.ts` | status, pairing code, unpair |
| `apps/client/src/pages/settings/TelegramTab.tsx` | token, pairing state, guide |

---

### Task 1: The source column

**Files:**
- Modify: `apps/server/src/modules/documents/documents.tables.ts`
- Create: `apps/server/drizzle/0014_*.sql` plus its snapshot, by generation
- Modify: `apps/server/src/modules/documents/documents.usecases.ts` (`upload`)
- Test: `apps/server/src/modules/documents/documents.usecases.test.ts`

**Interfaces:**
- Produces: `documents.source`, one of `upload`, `telegram`, `email`, defaulting to
  `upload`. `documentsService.upload` accepts an optional `source` and records it. Task 4
  passes `"telegram"`.

- [ ] **Step 1: Write the failing test**

```ts
  it("records where a document came from, defaulting to an upload", async () => {
    const { document: browser } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: bot } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]), source: "telegram" });

    expect((await documents.get({ userId, documentId: browser.id })).source).toBe("upload");
    expect((await documents.get({ userId, documentId: bot.id })).source).toBe("telegram");
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server exec vitest run documents.usecases`
Expected: FAIL, `source` is not a known property.

- [ ] **Step 3: Add the column**

In `documents.tables.ts`, after `storageKey`:

```ts
    // Where the document entered DocMind. Every row that predates Telegram intake is an
    // upload, which is what the default records.
    source: text("source").notNull().default("upload"),
```

- [ ] **Step 4: Generate the migration, in this task**

```bash
cd apps/server && pnpm db:generate --name add_document_source
```

Check the generated SQL adds the column with its default and does not rebuild the table.
Commit the generated files under `apps/server/drizzle/`. If generation fails for any
reason, revert the column and stop: a tables file without its migration breaks the running
dev server on the next watcher restart.

- [ ] **Step 5: Thread it through upload**

Add `source?: "upload" | "telegram" | "email"` to `upload`'s arguments, defaulting to
`"upload"`, and set it on the inserted row. Add it to the `Document` type if the type is
hand written rather than inferred.

- [ ] **Step 6: Run the suite**

Run: `pnpm --filter @docmind/server exec vitest run documents`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/documents apps/server/drizzle
git commit -m "feat(server): record where a document came from"
```

---

### Task 2: Talking to Telegram

**Files:**
- Create: `apps/server/src/modules/telegram/telegram.schemas.ts`
- Create: `apps/server/src/modules/telegram/telegram.client.ts`
- Create: `apps/server/src/modules/telegram/telegram.client.test.ts`

**Interfaces:**
- Produces: `createTelegramClient({ token, fetchImpl? })` with `getUpdates({ offset, timeoutSeconds })`,
  `getFile({ fileId })` returning `{ stream, fileName, sizeBytes }`, and
  `sendMessage({ chatId, text })`. Tasks 3 and 4 use all three.
- Produces: `telegramUpdateSchema`, the valibot schema the loop validates each update with.

- [ ] **Step 1: Write the failing tests**

Against a fake `fetchImpl`, never the network:

```ts
it("asks for updates from the offset and returns the parsed ones", async () => { /* ... */ });

it("keeps the bot token out of the error it throws", async () => {
  const client = createTelegramClient({ token: "123:SECRET", fetchImpl: async () => new Response("nope", { status: 401 }) });
  await expect(client.getUpdates({ offset: 0, timeoutSeconds: 0 })).rejects.toThrow(/telegram/i);
  await expect(client.getUpdates({ offset: 0, timeoutSeconds: 0 })).rejects.not.toThrow(/SECRET/);
});

it("refuses a file above Telegram's twenty megabyte download ceiling", async () => { /* ... */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run telegram.client`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the schema**

`telegramUpdateSchema` covers `update_id`, and an optional `message` with `message_id`,
`from.id`, `from.first_name`, `chat.id`, `text`, `caption`, `entities`, `document`,
`photo`, `video`, `audio`. Unknown fields are ignored rather than rejected: Telegram adds
fields routinely and a strict schema would turn every new one into an outage.

- [ ] **Step 4: Write the client**

Three calls against `https://api.telegram.org/bot<token>/<method>`. The token is in the
path, so any error message must be built from the method name and status, never from the
URL. `getFile` returns the body as a stream plus the size Telegram reports, and throws a
typed error above 20 MB before downloading anything.

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @docmind/server exec vitest run telegram`

```bash
git add apps/server/src/modules/telegram
git commit -m "feat(server): a small telegram bot api client"
```

---

### Task 3: What an update means

**Files:**
- Create: `apps/server/src/modules/telegram/telegram.models.ts`
- Create: `apps/server/src/modules/telegram/telegram.models.test.ts`

**Interfaces:**
- Produces: `intentOf(update, { paired })` returning one of
  `{ kind: "pairing", code }`, `{ kind: "file", fileId, fileName, mimeType, compressedPhoto }`,
  `{ kind: "text", text }`, `{ kind: "link", url }`, `{ kind: "ignore" }`.
  Also `newPairingCode()` and the reply texts. Task 4 consumes all of it. The `link` kind
  is recognized here but plan 2 implements what happens to it; until then the loop replies
  that links are not supported yet.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads a document message as a file", () => { /* ... */ });
it("takes the largest size of a photo, and marks it compressed", () => { /* ... */ });
it("reads a message Telegram marked entirely as a url as a link", () => { /* ... */ });
it("reads any other text as a note", () => { /* ... */ });
it("reads text as a pairing code only while unpaired", () => { /* ... */ });
it("ignores stickers, locations and edits", () => { /* ... */ });
it("generates a pairing code with no ambiguous characters", () => {
  for (let i = 0; i < 200; i++) expect(newPairingCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run telegram.models`

- [ ] **Step 3: Implement**

Pure, no IO. The link rule reads `entities`, not a regex: a message is a link when a single
entity of type `url` or `text_link` covers the whole trimmed text.

- [ ] **Step 4: Run and commit**

```bash
git add apps/server/src/modules/telegram
git commit -m "feat(server): read a telegram message as an intent"
```

---

### Task 4: The loop, pairing, and intake

**Files:**
- Create: `apps/server/src/modules/telegram/telegram.settings.ts`
- Create: `apps/server/src/modules/telegram/telegram.usecases.ts`
- Create: `apps/server/src/modules/telegram/telegram.usecases.test.ts`
- Modify: `apps/server/src/modules/settings/settings.definitions.ts` (register them)
- Modify: `apps/server/src/server.ts` (start the loop)

**Interfaces:**
- Consumes: the client (Task 2), the models (Task 3), `documentsService.upload` with
  `source: "telegram"` (Task 1).
- Produces: `createTelegramService({ settingsService, documentsService, clientFactory? })`
  with `runOnce()` (one poll cycle, which is what tests drive) and `start()`/`stop()`
  around it.

- [ ] **Step 1: Write the failing tests**

Driving `runOnce()` against a fake client, never the network:

```ts
it("does nothing at all while no bot token is configured", async () => { /* ... */ });

it("pairs with the first sender who quotes the code, then ignores everyone else", async () => { /* ... */ });

it("turns a file from the paired user into a document that knows it came from telegram", async () => {
  // ... after runOnce()
  const [document] = await documents.list({ userId });
  expect(document).toMatchObject({ name: "receipt.pdf", source: "telegram" });
  expect(sent.map((m) => m.text)).toContainEqual(expect.stringMatching(/got it/i));
});

it("tells the sender when a file is too large for Telegram to hand over", async () => { /* ... */ });

it("says it already has a file that was sent twice, rather than going quiet", async () => { /* ... */ });

it("mentions compression the first time a photo arrives, and not the second", async () => { /* ... */ });

it("never acts on a message from an unpaired user id", async () => { /* ... */ });

it("does not reprocess an update it already handled", async () => { /* ... */ });

it("backs off after a failure and recovers on the next cycle", async () => { /* ... */ });
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run telegram.usecases`

- [ ] **Step 3: Write the settings**

The five keys from the spec's table, `botToken` secret, the rest internal, registered in
`settings.definitions.ts` beside the others.

- [ ] **Step 4: Write the service**

`runOnce()` reads the token (returning immediately when there is none), builds a client,
asks for updates from `lastUpdateId + 1`, and handles each in order, advancing the cursor
after each so a crash mid-batch does not replay work already done. Pairing, file and text
intake, and the immediate reply live here. A link intent replies that links are not
supported yet, which plan 2 replaces.

`start()` runs `runOnce()` in a loop with the backoff from the spec. `stop()` ends it. The
loop is started from `server.ts` the way the job runner is.

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @docmind/server exec vitest run telegram` then the full server suite.

```bash
git add apps/server/src
git commit -m "feat(server): a telegram bot that takes files and notes"
```

---

### Task 5: The Telegram settings page

**Files:**
- Create: `apps/server/src/modules/telegram/telegram.routes.ts` and its test
- Create: `apps/client/src/lib/telegram-api.ts`
- Create: `apps/client/src/pages/settings/TelegramTab.tsx` and its test
- Modify: `apps/client/src/pages/settings/SettingsPage.tsx` (the new tab)
- Modify: `apps/server/src/server.ts` (register the routes)

**Interfaces:**
- Consumes: the service from Task 4.
- Produces: `GET /api/telegram/status`, `POST /api/telegram/pairing-code`,
  `POST /api/telegram/unpair`.

- [ ] **Step 1: Write the failing route tests**

```ts
it("reports no token, no pairing, and no code before anything is configured", async () => { /* ... */ });
it("issues a pairing code only when a token exists", async () => { /* ... */ });
it("never returns the bot token itself", async () => { /* ... */ });
it("unpairs and issues a fresh code", async () => { /* ... */ });
```

- [ ] **Step 2: Run, watch them fail, implement the routes**

Run: `pnpm --filter @docmind/server exec vitest run telegram.routes`

- [ ] **Step 3: Write the failing client tests**

```tsx
it("walks through BotFather before a token is saved", async () => { /* ... */ });
it("shows the pairing code and what to do with it once a token is saved", async () => { /* ... */ });
it("shows who it is paired with, and offers Unpair", async () => { /* ... */ });
it("never renders the saved token back into the field", async () => { /* ... */ });
```

- [ ] **Step 4: Build the tab**

Token field (secret, never rendered back), pairing state, the code in a copyable block, an
Unpair action, and the setup guide: message @BotFather, send `/newbot`, pick a name, copy
the token, paste it here, then send the code to your bot. Reuse the `GuideCard` the storage
tab already shares rather than writing a second guide renderer.

- [ ] **Step 5: Run everything and commit**

Run: `pnpm --filter @docmind/client test`, `pnpm --filter @docmind/server test`,
`pnpm typecheck`

```bash
git add apps/server/src apps/client/src
git commit -m "feat: a telegram settings page with pairing"
```

---

## Self-review

**Spec coverage.** Spec sections 1 to 5 are Tasks 2, 3 and 4; the database change is Task
1; sections 8 and 9 are Task 5. Section 6 (links) and section 7 (the second reply) are
plans 2 and 3 as the spec states.

**Decisions this plan makes rather than leaves open.** No Telegram SDK, because three
`fetch` calls are less surface than a dependency. The cursor advances per update rather
than per batch, so a crash mid-batch does not redo work. A link intent is recognized in
Task 3 but answered with "not yet" until plan 2, so the models file is not rewritten later.

**Type consistency.** `source`, the intent kinds, and the three route paths are spelled
identically everywhere they appear.

**The one risk worth restating.** Task 1 touches a tables file. If `db:generate` cannot
run, the column must be reverted rather than left behind, or the next watcher restart takes
down the dev server the user is testing through.
