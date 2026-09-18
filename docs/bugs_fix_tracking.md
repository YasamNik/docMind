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

