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

