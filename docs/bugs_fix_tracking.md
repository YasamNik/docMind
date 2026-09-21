# Bugs & Fixes Log

Simple append-only log of technical issues and their fixes. Entries are added by the
`bug-fix-record` agent after the user approves. Never delete or reorder entries.

Before debugging anything, search this file for the symptom first.

## libsql connection pool allowed concurrent connections, breaking single-connection assumption, 2026-09-18T01:28:57Z

**Component:** database
**Severity:** Major

### Symptoms
- Job runner and usecases assumed a single database connection (no nested transactions, sequential job processing)
- libsql's file-mode client defaulted to a pool of up to 20 connections
- A query issued while a transaction held the first connection silently opened a second connection

### Root Cause
- `@libsql/client` file-mode driver's `concurrency` config defaults to 20 when unset
- No code set it to 1

### Solution / Fix
- Added `concurrency: 1` to `createClient()` in `apps/server/src/modules/database/database.ts`

### Regression Test
- `apps/server/src/modules/database/database.test.ts`, "holds a file database to a single pooled connection"

---

## drizzle-kit 0006 snapshot was out of sync, causing duplicate ALTER TABLE in 0007, 2026-09-18T01:28:57Z

**Component:** database/migrations
**Severity:** Blocker

### Symptoms
- Running `pnpm db:generate --name chat` produced a migration that re-added `summary`, `suggested_title`, `summary_status`, `summary_error` columns that already existed from migration 0006
- Every test failed with "duplicate column name: summary" (180 failures)

### Root Cause
- `apps/server/drizzle/meta/0006_snapshot.json` was generated before the ALTER TABLE statements were hand-appended to `0006_document_chunks.sql`
- The snapshot never recorded those columns
- drizzle-kit's diff saw them as missing and re-generated them

### Solution / Fix
- Added the four missing column entries to `apps/server/drizzle/meta/0006_snapshot.json` to match the actual applied schema
- Then regenerated 0007 cleanly

### Regression Test
- `apps/server/src/modules/database/database.test.ts`, "creates the document_chunks table and the documents summary columns"

---

## Search and chat crashed with DrizzleQueryError when no documents were embedded, 2026-09-18T01:28:57Z

**Component:** search
**Severity:** Major

### Symptoms
- Chat endpoint returned 500 Internal Server Error with "Failed to send message" toast on client
- Server log: `DrizzleQueryError` referencing `vector_distance_cos(emb, ...)` on the document_chunks table

### Root Cause
- The `emb` column (F32_BLOB for vector embeddings) is added at runtime by ALTER TABLE when the first embedding job runs
- Before any document is embedded, the column does not exist
- The search usecase's try/catch only caught `ai.slot_not_configured` AppError, not the DrizzleQueryError from the raw SQL

### Solution / Fix
- Extended the catch in `apps/server/src/modules/search/search.usecases.ts` to also catch errors containing "vector_distance_cos" or "F32_BLOB" in the message
- Falls back to keyword-only search when vector search fails

### Regression Test
- `apps/server/src/modules/search/search.usecases.test.ts`, "search falls back to keyword-only with no embedding model configured"

---

## Per-slot Test button returned 500 because server didn't have the testSlot method loaded, 2026-09-18T01:28:57Z

**Component:** ai/settings
**Severity:** Minor

### Symptoms
- Clicking Test next to any model slot showed "Something went wrong" toast
- Server log: `TypeError: aiService.testSlot is not a function`

### Root Cause
- The `testSlot` method was added to `ai.usecases.ts` and the route to `ai.routes.ts`
- The tsx file watcher did not fully restart the server process
- The running server had the route registered but the old `aiService` object without `testSlot`

### Solution / Fix
- Full server restart (kill and re-run `pnpm dev`)
- Also improved the client error message to show a helpful hint instead of generic "Something went wrong"

### Regression Test
- `apps/server/src/modules/ai/ai.usecases.test.ts`, "resolves the chat slot and delegates to streamChat" (covers the slot resolution path used by testSlot)

---

## pnpm dev never started the API server because tsx watch does not run under pnpm --parallel, 2026-09-18T14:06:08Z

**Component:** server/build
**Severity:** Blocker
**Tags:** windows, dev-server, pnpm

### Symptoms
- On a fresh clone on a new Windows machine, `pnpm dev` brought up the Vite client on 5173 but the API server never bound port 4000 and printed no output
- Every /api call through the Vite proxy returned 502 Bad Gateway
- Sign-in page rendered blank with "Failed to load resource: 502" on /api/auth/status
- No docmind.sqlite was created, so the server never reached migrations

### Root Cause
- The server dev script was `tsx watch --env-file=.env src/index.ts`
- `tsx watch` supervises its own spawned child process and under pnpm's `--parallel` mode on Windows it never gets going
- Evidence: `pnpm -r --filter @docmind/server run dev` (no --parallel) starts in seconds; the same command with `--parallel` never binds after 120s
- `node --watch --import tsx --env-file=.env src/index.ts` under the same `--parallel` command binds in 10s and logs normally

### Solution / Fix
- Changed `apps/server/package.json` dev script to `node --watch --import tsx --env-file=.env src/index.ts`
- `start` and `build` scripts unchanged, Docker image runs `node dist/index.js` directly, no impact
- Node's --watch watches only the imported module graph, so writes to docmind.sqlite or the documents directory do not cause restart loops

### Regression Test
- None. A package manager script change cannot be covered by the vitest suite, and no such test exists.
- Verified manually instead: `pnpm dev` from the repo root, then the API on 4000, the client on 5173, and the `/api` proxy through 5173 all answer 200 within five seconds.

### Follow-up / Notes
- If the dev server is ever silent again, run the server package's dev script alone without --parallel to surface the error that parallel mode hides

---

## database pool test failed on Windows with EBUSY because libsql releases the file handle on GC, not on close, 2026-09-18T14:06:08Z

**Component:** database
**Severity:** Major
**Tags:** windows, libsql, test

### Symptoms
- `apps/server/src/modules/database/database.test.ts`, test "holds a file database to a single pooled connection", failed every run on Windows with `EBUSY: resource busy or locked, unlink 'C:\Users\...\AppData\Local\Temp\docmind-test-<uuid>.db'`
- The assertion under test passed; the failure came from the cleanup in the finally block

### Root Cause
- The native libsql binding (libsql 0.5.29 under @libsql/client 0.18.0) marks the wrapper closed when `close()` returns but releases the OS file handle only when the native object is finalized by garbage collection
- Proven by probe script: `close()` then unlink immediately gives EBUSY; `close()` plus delay still gives EBUSY; `close()` plus forced `global.gc()` plus delay unlinks successfully
- POSIX allows unlinking a file that is still open, so this cleanup worked by platform luck on Linux and macOS; on Windows it fails deterministically

### Solution / Fix
- Cleanup is now best effort in `apps/server/src/modules/database/database.test.ts`
- Temp databases go in a dedicated `docmind-db-tests` directory under the OS temp dir
- Each run sweeps the previous run's leftovers on the way in (files from a finished process are unlocked)
- Unlinks are wrapped so a failure cannot fail the test

### Regression Test
- `apps/server/src/modules/database/database.test.ts`, "holds a file database to a single pooled connection"

### Scope Note
- Test only: `client.close()` appears nowhere in production code
- The server holds its database open for the life of the process

### Follow-up / Notes
- Two concurrent server suites on one machine are out of scope, since the sweep is best effort and every file name is unique

---

## The link fetcher closed the connection before reading the response, 2026-09-19T05:02:44Z

**Component:** telegram/link-fetch
**Severity:** Major
**Tags:** network, hang, fake-test

### Symptoms
- The `/web` assistant command would stall for 5-20 seconds on most links
- Large pages (5MB+) would hang past the 20 second timeout
- Small pages (9 bytes) completed normally

### Root Cause
- The link fetcher built an undici Agent and closed it in a finally block that ran before the response body was read
- An unread body backpressures the socket; close() waits on a transfer that never finishes
- Small bodies fit in the buffer regardless; large bodies expose the hang

### Solution / Fix
- Moved close() outside the try block, only after the body is fully read, cancelled, or disposed
- Added discardBody() helper to cancel bodies on error paths (redirects, 4xx/5xx, wrong content type)
- DNS resolution now bounded by the same deadline as the fetch
- Telegram Bot API calls now have local timeouts (15s default, 60s for downloads)
- Address guard now refuses unspecified address, IPv4-compatible form, multicast and reserved ranges
- Changes in `apps/server/src/modules/telegram/link-fetch.ts`

### Regression Test
- `apps/server/src/modules/telegram/link-fetch.test.ts`, "closes the real dispatcher it builds only after reading a large body in full" (five megabyte local server test, real undici agent path)

### Follow-up / Notes
- Every other test injects a MockAgent, so the real path that builds an Agent ran nowhere else
- jsdom's fake dispatcher cannot reproduce socket backpressure; a local test server serves real bytes

---

## Trashing a mail destroyed unrelated documents, 2026-09-19T09:00:34Z

**Component:** documents/trash
**Severity:** Blocker
**Tags:** cascade, corruption

### Symptoms
- Emptying trash after trashing an email deleted PDF attachments that were never explicitly trashed
- An attachment the user uploaded themselves a month earlier, or one arriving with every email, persisted until the parent mail was purged
- The attachment itself never appeared in trash and gave no indication it existed

### Root Cause
- `remove()` called `repository.update()` on the document itself only, never walking the parentDocumentId tree
- `purge()` walked the subtree, so purging the trashed mail then deleted attachments that never went to trash at all
- Restoring the mail did not restore its children because `restore()` also did not walk the tree
- The relationship was invisible: no UI showed an attachment's parent or a mail's children until after the fix

### Solution / Fix
- Added `collectSubtree()` helper with depth cap (50) and visited set to prevent stack overflow on cycles
- `trashSubtree()` now walks the whole tree and stamps all at-risk children with the same deletedAt timestamp
- `restore()` reads that timestamp and restores only children that moved down together in the same cascade
- A child trashed separately before its parent stays in trash (the user's explicit decision is respected)
- `purge()` works unchanged: it only reaches children through a trashed parent, so it deletes exactly the subtree that went down together
- `bulkDelete()` now calls `trashSubtree()` to cascade
- Added parent/children links to DocumentDetail UI in `apps/client/src/pages/documents/DocumentDetailPage.tsx`
- Changes in `apps/server/src/modules/documents/documents.usecases.ts` and repository

### Regression Test
- `apps/server/src/modules/documents/documents.usecases.test.ts`, "purging a trashed mail deletes exactly the subtree that was trashed with it"
- "restores a mail and the attachment trashed with it in the same cascade"
- "does not restore a child that was trashed on its own before its parent"
- "collectSubtree tolerates a parentDocumentId cycle instead of looping forever"

### Follow-up / Notes
- Two supporting fixes: collectSubtree now guards against infinite recursion (depth and visited set)
- The detail page now shows the parent mail and attachment links, making the relationship visible and the bug detectable

---

## The dev server served code from half an hour earlier, 2026-09-19T12:00:00Z

**Component:** server/dev
**Severity:** Major
**Tags:** dev-server, watcher, testing

### Symptoms
- A change made and saved to a source file was not reflected when the live server was tested
- The running process was serving code from approximately 30 minutes before the source change
- Multiple test cycles passed even though the source was still buggy, because the tests were running against the old version

### Root Cause
- Not fully documented in the session: the watcher process detected changes but the restarted server was serving cached or previously loaded code
- Likely a timing issue where the dev server's module cache was not cleared on restart, or the file watcher had not detected the change yet when the process restarted

### Solution / Fix
- Identified as a testing hazard rather than a code bug: always verify the running dev server's start time is newer than the newest source file before trusting a test result
- No code change was required; the issue was in development practice

### Regression Test
- None. This is a dev-server behavior, not a testable code path.

### Follow-up / Notes
- To detect if this is happening: check the server's console output startup timestamp against the file's modification time
- If the dev server is silent or serving stale code, kill it and re-run `pnpm dev` in the server package directory to surface any hidden errors

---

## The Telegram assistant went silent forever after its chat session was deleted, 2026-09-19T13:16:56Z

**Component:** telegram/chat
**Severity:** Blocker
**Tags:** session, cleanup, state-machine

### Symptoms
- User deletes a conversation from the app's Chat page
- Every message sent to the Telegram bot afterwards gets no reply
- No error message is shown; the user gets silence
- The poll loop continues running but returns nothing

### Root Cause
- A Telegram conversation is bridged to an ordinary chat_sessions row
- Deleting the session from the Chat page left every later message failing on a session id that no longer resolved
- The poll loop retried the same broken session id, advanced its cursor, and the user received no reply at all

### Solution / Fix
- The turn now clears the stored session id and retries once on a fresh session
- Any other failure returns a plain acknowledgement instead of silence
- Responses to questions the assistant itself just asked are no longer swallowed when they are cheap (one or two words)
- Changes in `apps/server/src/modules/telegram/telegram.usecases.ts` and `chat.usecases.ts`

### Regression Test
- `apps/server/src/modules/telegram/telegram.usecases.test.ts`, includes test that verifies recovery from deleted session

### Follow-up / Notes
- A conversation bound to a deleted session now recreates it and continues, rather than silently failing

---

## Re-uploading a file you had trashed threw a 404 instead of storing it, 2026-09-19T13:36:32Z

**Component:** documents/upload
**Severity:** Major
**Tags:** trash, dedup, indexing

### Symptoms
- Upload a document, then trash it
- Try to re-upload the same file (same content hash)
- The server returns 404 instead of storing a new copy

### Root Cause
- `findByHash()` in `documents.repository.ts` did not filter `deletedAt`
- The `upload()` usecase deduped on content hash alone and returned the existing document
- The next call, `getEnrichedOrThrow()`, refused to read the trashed row and threw 404

### Solution / Fix
- Changed `findByHash()` to exclude rows where `deletedAt` is not null
- A re-upload of a trashed file now creates a new row with the same content hash but a different storage key
- Changes in `apps/server/src/modules/documents/documents.repository.ts`

### Regression Test
- `apps/server/src/modules/documents/documents.usecases.test.ts`, regression tests in the upload suite

---

## A mail whose attachment already existed was filed with no attachment, 2026-09-19T13:36:32Z

**Component:** email/upload
**Severity:** Major
**Tags:** dedup, parentage, recurring

### Symptoms
- An email arrives with an attachment that was already stored (e.g. a logo on every message, a recurring invoice PDF)
- The mail is filed but the attachment link is missing
- The PDF or document sits orphaned in the library with no parent
- The mail's detail view shows no attachments

### Root Cause
- `upload()` deduped on content hash alone and returned the existing document unchanged
- The new call passed `parentDocumentId: mail.id` but was ignored
- A mail with a recurring attachment never got the attachment link

### Solution / Fix
- A hash match now counts as the same upload only when it carries the same parent document
- If a retry (same mail id) replays with the same parent, it stays safe on its original guarantee
- If a different mail gets the same attachment, it gets its own row and its own storage key
- The existing row is never re-parented, which would let trashing one mail cascade into a document the user uploaded themselves
- Changes in `apps/server/src/modules/documents/documents.usecases.ts` (upload logic and `findByHash`)

### Regression Test
- `apps/server/src/modules/documents/documents.usecases.test.ts`, new tests verify that uploads with different parents create separate rows even with identical content hashes

---

## Typing in the phone chat composer came out backwards, 2026-09-19T13:52:05Z

**Component:** client/chat
**Severity:** Minor
**Tags:** input, selection, react, uncontrolled

### Symptoms
- One message at 13:30Z on 2026-09-19 read "ebAH i Od scOd ecnIl WhatW"
- Reversed: exactly "WtahW lInce dOcs dO i HAbe"
- Every character landed at position 0
- Not reproduced; a guard test is in place

### Root Cause
- A controlled input component was restoring a selection range after React's commit phase
- A stale range would put the caret at position 0
- The race happened only when input events and controlled binding both fired in the same frame

### Solution / Fix
- Made the input uncontrolled: nothing writes the value back to the DOM
- No selection to restore, no mechanism for the race to lock the caret at 0
- The Send button keeps its own flag for whether there is text
- Removing the controlled binding also stopped a re-render on every keystroke, which exposed another race it had been hiding

### Regression Test
- `apps/client/src/pages/chat/ChatPage.test.tsx`, "a composer that cannot be typed into backwards" - a guard test that pins the behavior, not a red-then-green proof (jsdom cannot reproduce React's selection restoration)

### Follow-up / Notes
- Uncontrolled binding exposed a real race: a session whose history resolves after a message has been sent would sync that history over the message and wipe it
- The sync now stands down once a message has been sent in the selected session, until the selection changes

---

## The assistant told the user it had no way to look in their own documents, 2026-09-19T16:18:24Z

**Component:** assistant/triage
**Severity:** Major
**Tags:** prompt, live-model, test-isolation

### Symptoms
- User asked the Telegram bot a question about their own documents
- The bot answered "I can't list your saved documents with my current tools"
- The `answerFromDocuments` tool was present in the tool array

### Root Cause
- The tool-choosing call was handed a prompt written for a call that gets document text injected into it: "answer from the context given to you in this conversation"
- Retrieval moved behind the answerFromDocuments tool, so that call never gets context at all
- The prompt was telling the model on every turn that it had nothing
- Whether it called the tool anyway rested on one line in the shipped instructions document, which the user can delete

### Solution / Fix
- Triage now has its own prompt that describes the assistant in terms of the tools it has
- Prompt says a question about the user's documents goes to the tool rather than to memory
- Prompt says outright that claiming no way to check is never true
- Test pins that the guidance survives an instructions document that says nothing about documents
- Changes in `apps/server/src/modules/assistant/assistant.models.ts`

### Regression Test
- `apps/server/src/modules/assistant/assistant.models.test.ts`, new test with custom instructions that omit documents entirely

### Follow-up / Notes
- Found by asking the live model under a terse custom instructions document; every mock test passed
- A fake adapter never decides it feels unable, so no test would have caught the real model's hesitation

---

## The Telegram bot answered like a search box instead of conversing, 2026-09-19T16:23:20Z

**Component:** assistant/answering
**Severity:** Major
**Tags:** prompt, surface, answering-mode

### Symptoms
- User asked the Telegram bot a question it could not answer from documents
- The bot responded "I don't have enough information to answer that"
- The conversational surface was supposed to answer freely instead

### Root Cause
- Both answering handlers hardcoded the app's chat prompt for every surface after tool calling moved answering behind the `answerFromDocuments` tool
- The tool call only tells the model what tools it has; it doesn't tell it which prompt to use when answering
- The Telegram surface inherited the chat prompt's "I don't have enough information" refusal, the exact behavior the conversational prompt existed to prevent

### Solution / Fix
- The answering prompt now follows the surface through one helper function instead of a ternary at two call sites
- Telegram and any future conversational surface get their own prompt; the app's chat keeps its own
- Changes in `apps/server/src/modules/assistant/assistant.models.ts` (new helper)

### Regression Test
- `apps/server/src/modules/assistant/assistant.models.test.ts`, "getPriceAnswerPrompt chooses the right prompt per surface"
- `apps/server/src/modules/assistant/assistant.registry.test.ts`, regression tests verify behavior per surface

### Follow-up / Notes
- Found live, not by a test: the bot's answer revealed the hardcoded prompt
- Plan 5 moves the app onto this same seam, so the helper future-proofs both surfaces

---

## A failed Telegram send bought a second model call, 2026-09-19T16:33:49Z

**Component:** telegram/delivery
**Severity:** Major
**Tags:** idempotency, retry, duplicate

### Symptoms
- Telegram message delivery fails transiently on the second part of a split reply
- The user sees a duplicate copy of their question in the chat history
- The second model call happens (and gets charged) even though the first already produced the full reply

### Root Cause
- The reply delivery loop had no retry, so a transient Telegram failure threw out of the handler into the poll loop's own retry
- The retry re-ran the whole turn: another paid model call, another copy of the user's question in the session, and that copy read back as history on the next turn
- Any ordinary network blip was enough; no crash or bug needed

### Solution / Fix
- The send now retries on its own (same way a poisoned update is skipped) and gives up quietly
- A turn that already produced an answer is never run again
- The cursor stays where it is: advancing before handling would drop a file or note on a crash (losing data is worse than a duplicate reply)
- The constraint is written next to the cursor code
- Changes in `apps/server/src/modules/telegram/telegram.usecases.ts`

### Regression Test
- `apps/server/src/modules/telegram/telegram.usecases.test.ts`, comprehensive tests of send and update delivery, idempotency on retry, and cursor positioning

### Follow-up / Notes
- Four reviewer memory files moved to `.claude/agent-memory/plan-reviewer/` where all agent memory lives
- The open question: advancing the cursor before handling would prevent duplicates but risks losing a document on crash; the current choice accepts duplicates to avoid data loss

---

## A connected mailbox was told to go and create an app password, 2026-09-19T23:56:44Z

**Component:** client/email
**Severity:** Major
**Tags:** setup, oauth, guide

### Symptoms
- A Gmail mailbox connected via OAuth was shown the IMAP setup guide
- The guide tells the user to create an app password and enter a host, port, and mailbox address
- All of those are wrong for the OAuth mode and none of them are shown in the UI
- This was the exact text the user could not follow, which is what prompted the whole Gmail OAuth feature

### Root Cause
- The guide was chosen with `status.mode === "unconfigured" && status.googleAppAvailable ? gmailGuide : imapGuide`
- The Gmail guide only showed while nothing was connected
- The moment Gmail connected, the panel fell back to the IMAP guide because the mode was no longer "unconfigured"

### Solution / Fix
- Added a connected mailbox panel that shows what DocMind does with the folder and when Google will expire the connection
- The guide selector now chooses based on the resolved mode (unconfigured, gmail, imap) rather than checking only `status.mode`
- Added regression test asserting the app password sentence is nowhere on screen when connected
- Changes in `apps/client/src/pages/settings/EmailTab.tsx`

### Regression Test
- `apps/client/src/pages/settings/EmailTab.test.tsx`, "a connected mailbox" (regression test added in this commit)

---

## The bot answered a voice note with silence, 2026-09-20T00:40:50Z

**Component:** telegram/voice
**Severity:** Blocker
**Tags:** telegram, input-type, transcription, test-isolation

### Symptoms
- A user sent a voice note to the Telegram bot (held-to-record audio)
- The bot received the message but sent no reply at all
- No error or fallback message appeared; the user got silence
- Other message types (text, photo, audio files) replied normally

### Root Cause
- Telegram sends a held-to-record voice note in a `voice` field, distinct from `audio` (which is an attached audio file)
- The schema and intent detection had `audio` but neither knew about `voice`
- A voice note matched no intent and produced no reply
- Regression tests written first failed with "expected [] to have a length of 1 but got +0", the signature of a missing reply

### Solution / Fix
- Added `voice` field to the Telegram message schema in `telegram.schemas.ts`
- Added voice intent to `intentOf()` in `telegram.models.ts`
- Voice notes transcribe through the AI layer and are treated exactly as typed text
- Same triage, confirmation guard, and save confirmation apply to voice as to any message
- Transcription failures (too large, provider error, no audible content) return a plain sentence instead of silence
- Changes in `apps/server/src/modules/telegram/telegram.schemas.ts`, `telegram.models.ts`, and `telegram.usecases.ts`
- Added transcribeAudio method to ai adapters and ai.usecases

### Regression Test
- `apps/server/src/modules/telegram/telegram.usecases.test.ts`, "transcribes a voice note and answers it exactly like a typed message"

### Follow-up / Notes
- The fix was never caught by the test suite before writing regression tests because the fake Telegram update fixture never carried a `voice` field
- Fake fixtures do not naturally include fields that nobody wrote support for
- This is an instance of the broader pattern: a test that injects a fake cannot catch defects in what the real system does

---

## Em dashes reached the user in six of the last twelve assistant replies, 2026-09-20T01:22:08Z

**Component:** assistant/output
**Severity:** Major
**Tags:** prompt, formatting, live-model, test-isolation

### Symptoms
- Six occurrences of em dashes in five of the last twelve assistant replies in production
- Examples: "anything more recent-or point me" and "your documents - I only have access to"
- The shipped instructions document asked the model for none: "No em dashes anywhere"
- The model simply did not obey that line

### Root Cause
- Instructions are prompts and prompts can be argued with
- The model chose to use em dashes anyway
- A rule that must hold cannot rest on a prompt request; it must be code
- No test caught this because a fake model adapter returns whatever the test author wrote, never an em dash the real model chose

### Solution / Fix
- Created `removeEmDashes()` pure function that handles three cases: digit ranges (become hyphens), clause separators (become commas), and plain hyphens in filenames (untouched)
- Applied once where a reply is finished, not inside each capability
- Every tool, failure path, and future tool are covered by this one place
- Changes in `apps/server/src/modules/assistant/assistant.models.ts` and `assistant.usecases.ts`
- Added `chat.usecases.ts` to apply the same function to saved messages
- Added comprehensive tests for each case (digit range, clause, filename hyphen)

### Regression Test
- `apps/server/src/modules/assistant/assistant.models.test.ts`, test "removeEmDashes converts em/en dashes to punctuation or hyphens"
- `apps/server/src/modules/assistant/assistant.usecases.test.ts`, test "chat reply that would have reached the user still gets cleaned"

### Follow-up / Notes
- The chat page still streams raw tokens to the browser, so a dash can flash live before the saved message is cleaned
- That gap closes when plan 5 moves the chat page onto the same path
- This is an instance of the broader pattern: the prompt asks the real model for something it does not obey, but a test with a fake adapter never discovers this gap

---

## A merge conflict marker was left in WORKLOG.md for several hours, 2026-09-20T01:43:02Z

**Component:** docs/worklog
**Severity:** Minor
**Tags:** merge, conflict, markdown

### Symptoms
- The opening conflict marker `<<<<<<< HEAD` was left in WORKLOG.md after resolving a merge
- The `=======` and `>>>>>>>` markers were removed by the resolution script
- Nothing looked obviously broken because the conflict markers were incomplete
- No test covers markdown file structure, so the break was not caught by the test suite

### Root Cause
- Merging the office machine's document types branch caused a conflict in WORKLOG.md
- The conflict was resolved with a script that spliced the two sides together to preserve the file's header
- The slice that preserved the header included the opening `<<<<<<< HEAD` line by mistake
- The markers were found when the file was read during the end of session routine

### Solution / Fix
- Manually removed the `<<<<<<< HEAD` marker from the file
- This fix is in commit 29c4797 which documents the WORKLOG entry for that session

### Regression Test
- None. A merge-conflict pattern cannot be covered by the vitest suite.

### Follow-up / Notes
- What would have caught it: a check for conflict markers across the whole tree after resolving a merge
- Current practice only checks files that still show as conflicted in git status

---

## Every line item on a receipt was silently discarded, 2026-09-20T19:25:00Z

**Component:** budget/receipt-parsing
**Severity:** Major
**Tags:** schema, json-mode, parsing

### Symptoms
- Walmart receipt read correctly: merchant, date, and total stored
- budget_receipt_items table stayed empty for all line items
- Receipt appeared imported and had nothing on it

### Root Cause
- budgetReceiptReplySchema left items field as v.unknown(), following the rule that LLM reply schemas stay loose
- Under strict JSON schema mode, provider rendered the untyped field as a string instead of array
- Live reply contained `"items": "[{\"description\": \"HAND TOWEL\", \"amount\": \"2.97\", ...}]"` (stringified array)
- normalizeReceiptItemRows expected an array and returned nothing when it saw a string

### Solution / Fix
- Schema now describes items as an array so provider returns typed array (each row still loose)
- Normalizer now parses stringified arrays as fallback
- Changes in `apps/server/src/modules/budget/receipt.models.ts` and `receipt.usecases.ts`

### Regression Test
- `apps/server/src/modules/budget/budget.usecases.test.ts`, tests in receipt parsing suite verify items are extracted correctly

---

## A receipt with a printed total and no line items was marked ready, 2026-09-20T19:25:00Z

**Component:** budget/receipt-validation
**Severity:** Major
**Tags:** validation, reconciliation, empty-state

### Symptoms
- Receipt with printed total and zero line items marked ready instead of needs_review
- Month total would be correct while category breakdown empty
- Nothing indicated why the receipt had no items

### Root Cause
- normalizeReceiptReply only reconciled when items.length > 0
- Empty array skipped the reconciliation check entirely

### Solution / Fix
- Reconciliation now runs for empty items
- Receipt marked needs_review unless total is genuinely zero
- Changes in `apps/server/src/modules/budget/receipt.usecases.ts`

### Regression Test
- `apps/server/src/modules/budget/budget.usecases.test.ts`, test verifies empty-items receipt is marked needs_review

---

## The review flag was about to fire on every taxed receipt, 2026-09-20T19:28:26Z

**Component:** budget/receipt-validation
**Severity:** Major
**Tags:** reconciliation, tax, validation

### Symptoms
- Real Metro receipt: four lines summing to 23.09, tax 4.18, printed total 27.27
- Every line read correctly
- Receipt sent for review over a gap that was exactly the tax
- Flag that fires on everything is one users stop reading

### Root Cause
- Line items printed before tax, total printed after
- Comparing item sum against printed total flagged correct reads as gaps when tax was present
- Reconciliation logic assumed tax was never in the total

### Solution / Fix
- Stated tax now reconciles against the total with or without it
- Some places print tax inclusive in line item prices
- Changes in `apps/server/src/modules/budget/receipt.usecases.ts`

### Regression Test
- `apps/server/src/modules/budget/budget.usecases.test.ts`, test verifies taxed receipt is marked ready (not needs_review)

---

## Re-reading a receipt doubled every line, 2026-09-20T19:30:14Z

**Component:** budget/receipt-update
**Severity:** Major
**Tags:** idempotency, duplication, job-retry

### Symptoms
- Second read of a receipt left doubled line items (8 where there were 4)
- Category breakdown would double with them
- Job runner retries failed jobs, so transient failure after partial write would duplicate silently

### Root Cause
- updateReceiptWithItems inserted items without clearing previous ones
- No delete-then-insert pattern

### Solution / Fix
- Clear previous items before inserting new ones in updateReceiptWithItems
- Changes in `apps/server/src/modules/budget/receipt.usecases.ts`

### Regression Test
- `apps/server/src/modules/budget/budget.usecases.test.ts`, test verifies second update of same receipt does not duplicate items

---

## Scanning a receipt on a phone did nothing, 2026-09-20T19:39:08Z

**Component:** client/camera
**Severity:** Blocker
**Tags:** camera, upload, android, session-storage

### Symptoms
- User could scan receipt but clicking OK after image did nothing
- Page returned to budget with no receipt uploaded
- User: "It let me scan, but then when click ok after imeaged, nothing is happen and back to budget page"

### Root Cause
- Capture sheet held each photo in memory as File, only uploaded when Save was pressed
- Android backgrounds the tab while camera is open
- Chrome usually reloads page on return, destroying staged photo before Save reachable
- Server received no bytes at all

### Solution / Fix
- Each photo now uploads the moment it is taken
- IDs of pages that made it uploaded are kept in session storage
- Reload reopens sheet with shots already taken
- Residual limit: photo whose upload had not finished when reload hit is still lost (cannot be fixed from page alone)
- Changes in `apps/client/src/pages/budget/CaptureSheet.tsx`

### Regression Test
- `apps/client/src/pages/budget/CaptureSheet.test.tsx`, test verifies photos survive page reload via session storage

---

## A saved receipt was invisible, and receipt photos cluttered the library, 2026-09-21T00:27:20Z

**Component:** budget/receipt-dates; library/filtering
**Severity:** Major
**Tags:** date-parsing, display, organization, prompt

### Symptoms
- Saved receipt not visible anywhere (user: "i do not see them anywhere")
- Receipt photos appeared in docs/library instead of budget section (user: "should be inside the budget section")
- Real Metro receipt printed `DateTime: 26/09/20` read as 2020-09-26 instead of 2026-09-20
- Filed six years back, out of month being viewed

### Root Cause
- Model read receipt dates without today's date context
- Metro printed YY/MM/DD format (26/09/20 = 2026-09-20) but model read DD/MM/YY (2020-09-26)
- Both readings defensible without today's date, neither guaranteed correct
- Receipt with no date had no fallback
- Receipt pages appeared in every library view like ordinary documents

### Solution / Fix
- Prompt now includes today's date with never-in-the-future, nearest-plausible-reading rule
- Genuinely old receipt keeps its real date
- No-date receipt takes scan date and labels it as such
- Saving receipt lands user on the receipt page
- Empty month names the nearest month that has one
- Receipt pages excluded from every library view (text and embedding preserved)
- Changes in `apps/server/src/modules/budget/receipt.models.ts` (prompt) and `apps/server/src/modules/documents/documents.usecases.ts` (filtering)

### Regression Test
- `apps/server/src/modules/budget/budget.usecases.test.ts`, test verifies Metro receipt with YY/MM/DD date gets correct date
- `apps/server/src/modules/budget/budget.usecases.test.ts`, test verifies no-date receipt takes scan date
- `apps/server/src/modules/documents/documents.usecases.test.ts`, test verifies receipt pages don't appear in library search

---

## A Gmail IMAP timeout killed the entire server, 2026-09-20T19:41:00Z

**Component:** email/imap
**Severity:** Blocker
**Tags:** error-handling, eventEmitter, unhandled

### Symptoms
- API returned 502 Bad Gateway
- Entire app went down: chat and documents both inaccessible
- IMAP connect to imap.gmail.com timed out
- Pending AUTHENTICATE then failed
- imapflow instance emitted error event with no listener
- Node terminated process on unhandled error event from EventEmitter

### Root Cause
- No error listener attached at imapflow connection creation
- Every command already reported failure through timeout wrapper
- Transient timeout on one mailbox took down everything

### Solution / Fix
- Attach error listener at connection creation
- One line attaches listener; all commands already report through wrapper so nothing else needed
- Changes in `apps/server/src/modules/email/imap-connect.ts`

### Regression Test
- `apps/server/src/modules/email/email.usecases.test.ts`, test verifies IMAP error event doesn't crash server

---

## Cross-cutting: Tests that only meet fakes cannot catch defects in real counterparties, 2026-09-19T17:00:00Z

**Component:** testing
**Severity:** Major
**Tags:** test-isolation, fake, mock, integration

### Pattern
- Four bugs in this batch were never caught by tests because the test injected a fake
- Link fetcher: every test injected a MockAgent; the real path building an Agent ran nowhere else
- Triage call: a fake adapter never decides it feels unable; the real model's hesitation was never tested
- Telegram bot prompt: mock calls always behave as expected; real API never confirmed the prompt worked
- Telegram failed send: mocks don't fail transiently; the real transport was never stressed
- Voice note field: fake Telegram update fixtures never carried a `voice` field nobody wrote support for; that path ran nowhere else
- Em dashes: a fake model adapter returns whatever the test author wrote, never an em dash the real model chose

### Recent batch (2026-09-20)
- Items 1, 2, 3, 4 were found by putting one real receipt photo through the real model while 1130 tests passed
- Item 5 was found by the user on a real phone: jsdom test never backgrounds itself to open a camera
- Item 7 was found by the API dying in front of the user: fake adapters never emit unhandled errors

### Impact
- A test that stubs the counterparty (HTTP client, LLM, message queue) validates only the stub
- It cannot catch timing issues, selection bugs, or mismatch between the prompt and real behavior
- It cannot catch that the code path exists and is wired correctly
- It cannot catch what a real system does when nobody wrote a test author's expectation for it

### Recommendation
- At least one test per surface should meet the real thing or a high-fidelity stand-in
- Link fetcher now has a local HTTP server test
- Triage and answering paths should have one call to a real model before shipping
- Telegram send/retry paths could stress-test a real transport once, with a slow or lossy mode
- New inputs (voice notes) need at least one real fixture test alongside the fake ones
- Model behavior (em dashes) needs sample checking against the live model before declaring a prompt rule done
- Receipt parsing needs at least one real receipt through the real model before shipping a format change

---

