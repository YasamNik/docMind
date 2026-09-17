# Milestone D1: Embeddings and Vector Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document chunking, embedding through the AI service's embedding slot, FTS5 keyword search, hybrid search with reciprocal rank fusion, a search API endpoint, and a search page on the client. After D1, the user can search their document library by keyword, by meaning, or both.

**Architecture:** One new server module, `search`, owns the `document_chunks` table, the FTS5 virtual table, the embedding column on chunks (libsql native `F32_BLOB`), the chunking algorithm, the embedding job handler, and the hybrid search usecase. The extraction handler is extended to enqueue an `embedding` job (alongside the existing `rules` job) in the same transaction that marks extraction done. A new internal settings flag `ai.embedding.activeDimension` records the dimension of the active embedding model; the settings module gains an `internal` flag on `SettingDefinition` to hide this from the API and UI. The client gets a `/search` page in the sidebar. No new npm dependencies.

**Tech Stack:** Same as Phase 1. libsql 0.5.29's native vector support (`F32_BLOB(n)` column, `vector()`, `vector_distance_cos()`) confirmed working through `@libsql/client` 0.18.0 and drizzle-orm. No sqlite-vec extension needed.

**Spec:** `docs/superpowers/specs/2026-09-17-phase-2-find-and-ask-design.md` (sections 3-8, 12-14), `docs/superpowers/specs/2026-09-17-phase-2-find-and-ask-design.review.md` (blockers B1/B2, majors M1-M3, rulings 1-7, edge cases 1/4).

## Global Constraints

- Node 22 via nvm, pnpm via corepack. Before any pnpm command in a fresh shell: `source ~/.nvm/nvm.sh && nvm use 22 && corepack enable`.
- Every HTTP input, job payload, and LLM reply is parsed with valibot before use.
- All database access through Drizzle. Raw SQL only in migrations and for the FTS5 virtual table, FTS5 triggers, and vector operations (the `F32_BLOB` column, `vector()`, `vector_distance_cos()`). This matches the server-modules rule: "Raw SQL only in migrations and for the sqlite-vec virtual table."
- **Database change: this plan creates one migration** (`0006_document_chunks`). Per the Autonomy section of CLAUDE.md, the executor must get the user's explicit yes before running `pnpm db:generate` and before committing the generated migration. Task 1 is marked accordingly.
- Single libsql connection (`concurrency: 1`): never call a query through the outer `db` handle from inside a `db.transaction(async (tx) => ...)` callback, and never nest a second `db.transaction` inside one already open. Every write inside a transaction goes through the `tx` handle passed into the callback.
- The extraction and embedding job handlers keep the document status columns (`extraction_status`, `embedding_status`) a faithful cache of the latest job of each type for that document.
- Error codes are asserted in tests through `expectAppError(run, code)` from `apps/server/src/shared/test/errors.test-utils.ts`.
- Module files are named by role. Tests sit next to the file as `*.test.ts`. Per `.claude/rules/server-modules.md`, a `*.repository.ts` file has no dedicated test file; its behavior is covered by the matching `*.usecases.test.ts`.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- `ref_code/` is reference only. Never copy from it, never import it.
- Conventional commits, subject line first, blank line, then the harness's attribution trailers on their own lines.
- Run server tests with `pnpm --filter @docmind/server test`, client tests with `pnpm --filter @docmind/client test`. Run `pnpm typecheck` from the root before every commit.
- Timestamps are ISO 8601 strings in UTC.

## Decisions made in this plan

Per the autonomy rule in CLAUDE.md, the spec, and the spec review rulings, these implementation details are settled here.

1. **No sqlite-vec extension.** libsql 0.5.29 has native vector support: `F32_BLOB(n)` column type, `vector()` SQL function to create vectors from a JSON array string, and `vector_distance_cos()` for cosine distance. All confirmed working through `@libsql/client` 0.18.0 with `concurrency: 1` and through Drizzle's `sql` tagged template. No extension loading, no second driver, no new npm dependency. The spec's decision 13 and risk 1 are fully resolved.

2. **Embedding column lives on the `document_chunks` table, not a separate vec table.** Since libsql's native vectors are regular columns (not a virtual table), the simplest approach is adding an `emb` column of type `F32_BLOB(<dimension>)` directly to `document_chunks`. However, the dimension depends on the configured model and is not known at migration time. Therefore: the migration creates `document_chunks` without the `emb` column; the search module adds the column at runtime via `ALTER TABLE document_chunks ADD COLUMN emb F32_BLOB(<dim>)` when the first embedding is stored. This is simpler than a separate vec table, needs no FK alignment, and the FTS5 delete trigger and cascade delete from `documents` cover both text and embeddings automatically. The spec's runtime vec table management maps cleanly to runtime column management.

3. **Brute-force cosine distance, no ANN index.** For a single-user app the expected scale is hundreds to low thousands of chunks. `vector_distance_cos()` with `ORDER BY` and `LIMIT` handles this in milliseconds. libsql's `vector_top_k()` ANN function exists but returns only the rowid, not the distance, requiring a separate distance computation. Brute-force is simpler and sufficient. If scale ever becomes an issue, the ANN index (`libsql_vector_idx`) can be added with one `CREATE INDEX` statement and no schema change.

4. **`ai.embedding.activeDimension` uses the new `internal` flag on `SettingDefinition`.** Per review ruling 7 and blocker B2, `SettingDefinition` gains an `internal: boolean` field (default `false`). Internal settings are filtered out of `listResolved` (so the Settings page never shows them) and rejected by the public `set()` path (so the API cannot tamper with them). The embedding pipeline writes this setting through a new `setInternal()` method on the settings service that bypasses the public validation gate.

5. **Vec table lifecycle maps to ALTER TABLE + DROP COLUMN.** The spec's `ensureVecTable` / `dropVecTable` / `insertVectors` / `searchVectors` API maps to:
   - `ensureEmbeddingColumn(dimension)`: if no `emb` column exists, `ALTER TABLE document_chunks ADD COLUMN emb F32_BLOB(<dim>)`. If it exists with a different dimension, that is an error (dimension mismatch on existing data must go through the reset flow, not silent overwrite).
   - `dropEmbeddingData()`: `UPDATE document_chunks SET emb = NULL` (clears all vectors, keeps chunks for FTS). Called during the model-change reset.
   - `insertEmbedding(chunkId, vectorJson)`: `UPDATE document_chunks SET emb = vector(?) WHERE id = ?`.
   - `searchByVector(queryVecJson, limit, documentIds?)`: raw SQL with `vector_distance_cos`.
   Note: dropping and recreating the column (`ALTER TABLE ... DROP COLUMN emb` then re-add) is the cleanest approach for dimension change, but SQLite `ALTER TABLE DROP COLUMN` has restrictions. Instead, for a model change, we delete all chunks entirely (they need re-embedding anyway, so FTS data is stale too), drop and recreate the column by recreating the table (or just `DROP COLUMN` plus `ADD COLUMN` if the SQLite version supports it). Testing will confirm. The fallback is: delete all chunk rows, then the next embed cycle creates fresh rows with the new dimension's column.

6. **Embedding job is parallel with rules, not dependent.** After extraction completes, the extraction handler enqueues both `rules` (if auto items exist) and `embedding` (if an embedding model is configured) in the same transaction. They run independently through the sequential job runner. Per spec decision 6.

7. **Extraction failure sets `embedding_status` to `failed`.** Per review major M3 and the extraction handler's existing pattern, the `isFinalAttempt` failure branch now also sets `embeddingStatus: "failed"` and `embeddingError: "Extraction failed"`.

8. **Bulk re-embed is manual only.** Per review ruling 3, a "Re-embed all" action on the search page (or settings page) enqueues embedding jobs for all documents with `embedding_status = 'pending'` or `'done'`. Not automatic on startup. The endpoint is `POST /api/search/reembed-all`.

9. **Zero-chunk documents set `embedding_status = 'done'`.** Per review edge case 4, a document with empty extracted text produces zero chunks and the embedding job sets `embedding_status = 'done'` with no chunks inserted. This is expected, not a failure.

10. **Vec cleanup on document delete is automatic through cascade.** When a document is deleted, `ON DELETE CASCADE` deletes its `document_chunks` rows (which carry the `emb` column). No additional cleanup needed, unlike the spec's original design with a separate vec table. The FTS5 delete trigger handles the FTS index. This resolves review major M2 with zero additional code.

11. **Dimension mismatch on existing data fails the job.** Per review ruling 6, the per-document embedding job may add the `emb` column when it does not exist yet (first embed ever, or right after a model-change reset), but must never drop existing embeddings if the dimension does not match. A mismatch sets `embedding_status = 'failed'` with a clear error message directing the user to change the model through settings (which triggers the explicit reset flow).

12. **FTS5 query escaping.** FTS5 MATCH syntax interprets special characters as operators. The search module escapes user queries before passing them to MATCH: wrap each token in double quotes so FTS5 treats it as a literal phrase token.

13. **Hybrid search fallback behavior.** If no embedding model is configured, search falls back to keyword-only (FTS5). If FTS5 returns no results for rare query terms, the vector results alone are used. If no embeddings exist yet, keyword-only is used. All fallbacks are automatic and transparent.

14. **Embedding batch size is 20 texts per API call.** Per spec decision 15. This is a constant in the search module.

15. **The `document_chunks` table columns.** `id` (integer PK autoincrement), `document_id` (text FK to documents, cascade delete), `chunk_index` (integer), `chunk_text` (text), `token_count` (integer), `start_char` (integer), `end_char` (integer), `created_at` (text). The `emb` column is added at runtime (decision 2). Indexes on `(document_id)` and `(document_id, chunk_index)`.

16. **D3 columns included in D1's migration.** Per spec section 13, the four new `documents` columns (`summary`, `suggested_title`, `summary_status`, `summary_error`) are included in migration `0006_document_chunks` because D3 is small, the columns are nullable or have safe defaults, and D3's migration would otherwise be a near-empty file. Existing documents gain `summary_status = 'pending'`.

17. **The search page has no type-ahead.** The initial search page is a simple form: type a query, press Enter or click Search, see results. Debounced type-ahead is a later enhancement. This keeps the first version simple and avoids unnecessary API calls during typing.

18. **Route naming.** The API endpoint is `GET /api/search?q=...`. The client route is `/search`, added to the sidebar rail as a new entry between Files and Tags.

## Interfaces inherited

- `apps/server/src/shared/errors/errors.ts`: `createError({ code, message, status? })` returns `AppError`; `isAppError(error)`.
- `apps/server/src/shared/http/validate.ts`: `parseJsonBody(c, schema)`, `parseOrValidationError(schema, value)`.
- `apps/server/src/shared/test/database.test-utils.ts`: `createTestDatabase()` returns `{ db }`, migrated in-memory.
- `apps/server/src/shared/test/app.test-utils.ts`: `createTestApp({ env?, ocrEngine?, adapterFactories? })` returns `{ app, db, services, config, signIn }`.
- `apps/server/src/shared/test/errors.test-utils.ts`: `expectAppError(run, code)`.
- `apps/server/src/modules/database/database.ts`: `type Database`, `createDatabase({ url })`, `asTxDb(tx)`.
- `apps/server/src/modules/database/schema.ts`: re-exports every module's `*.tables.ts`.
- `apps/server/src/modules/documents/documents.tables.ts`: `documentsTable` with `id, userId, name, ..., extractionStatus, ..., ruleStatus, ..., embeddingStatus, embeddingError, categoryId, categorySource, createdAt, updatedAt`.
- `apps/server/src/modules/documents/documents.types.ts`: `Document`, `NewDocument`, `DocumentView`, `DocumentListRow`.
- `apps/server/src/modules/documents/documents.repository.ts`: `createDocumentsRepository({ db })` with `findById`, `update`, `listByUser`.
- `apps/server/src/modules/documents/documents.usecases.ts`: `createDocumentsService({ db, storageService, onUploaded? })` with `get`, `list`, `remove`.
- `apps/server/src/modules/jobs/jobs.types.ts`: `Job` with all columns; `JobStatus`.
- `apps/server/src/modules/jobs/jobs.models.ts`: `newJobId()`, `nowIso()`, `backoffMs(attempt)`.
- `apps/server/src/modules/jobs/jobs.usecases.ts`: `createJobsService({ db })` with `enqueue({ userId, type, payload, tx? })`, `list`, `retry`.
- `apps/server/src/modules/jobs/jobs.runner.ts`: `type JobHandler`, `createJobRunner({ db, handlers, ... })` with `runOnce()`, `start()`, `stop()`.
- `apps/server/src/modules/extraction/extraction.usecases.ts`: `createExtractionService({ db, documentsService, settingsService, registry, rulesService })` with `handler: JobHandler`, `extractDocument`.
- `apps/server/src/modules/ai/ai.usecases.ts`: `createAiService(...)` returns `resolveSlot(userId, task)`, `embed({ userId, task, texts }) -> Promise<EmbedResult>`.
- `apps/server/src/modules/ai/ai.types.ts`: `EmbedResult = { vectors: number[][], dimension: number }`, `ModelSlot = "rules" | "chat" | "embedding"`.
- `apps/server/src/modules/settings/settings.types.ts`: `SettingDefinition`, `ResolvedSetting`.
- `apps/server/src/modules/settings/settings.usecases.ts`: `createSettingsService(...)` with `get<T>(userId, key)`, `set(userId, updates)`, `listResolved(userId)`.
- `apps/server/src/modules/settings/settings.registry.ts`: `defineSetting({ key, schema, ... })`, `createSettingsRegistry(definitions)`.
- `apps/server/src/modules/settings/settings.definitions.ts`: `allSettingDefinitions` array.
- `apps/server/src/server.ts`: `createServer({ config, db, ocrEngine?, adapterFactories? })`.
- Client `src/lib/api.ts`: `api.get<T>(path)`, `api.json<T>(method, path, body)`.
- Client `src/App.tsx`: routes under `RequireSession`/`AppShell`.
- Client `src/components/layout/AppShell.tsx`: `railItems`, `tabForPath`, `IconRail`, context panels.

## File structure

### Server: `apps/server/src/modules/search/`

| File | Responsibility |
|------|-----------------|
| `search.tables.ts` | Drizzle table: `documentChunksTable` |
| `search.types.ts` | `DocumentChunk`, `NewDocumentChunk`, `ChunkResult`, `SearchResult`, `EmbeddingJobPayload` |
| `search.models.ts` | Pure functions: chunking, RRF scoring, FTS5 query escaping |
| `search.schemas.ts` | Valibot schemas: search query params, embedding job payload, search response |
| `search.repository.ts` | Chunk CRUD (Drizzle), FTS5 queries (raw SQL), vector operations (raw SQL) |
| `search.usecases.ts` | Embedding pipeline (chunk + embed + store), hybrid search, re-embed-all |
| `search.routes.ts` | `GET /api/search`, `POST /api/search/reembed-all` |
| `search.settings.ts` | `ai.embedding.activeDimension` internal setting definition |
| `search.models.test.ts` | Unit tests for chunking and RRF |
| `search.usecases.test.ts` | Integration tests for embedding pipeline and hybrid search |
| `search.routes.test.ts` | Integration tests for the search API |

### Modified server files

| File | Change |
|------|--------|
| `modules/settings/settings.types.ts` | Add `internal?: boolean` to `SettingDefinition` |
| `modules/settings/settings.usecases.ts` | Add `setInternal()` method, filter internal from `listResolved`, reject internal in public `set()` |
| `modules/settings/settings.definitions.ts` | Import and include search setting definitions |
| `modules/extraction/extraction.usecases.ts` | Enqueue `embedding` job, set `embeddingStatus`/`embeddingError` on extraction failure |
| `modules/database/schema.ts` | Re-export search tables |
| `modules/database/database.test.ts` | Migration test for new table |
| `server.ts` | Create search service, register search routes, add `embedding` handler to job runner |

### Client

| File | Responsibility |
|------|-----------------|
| `src/lib/search-api.ts` | New: `searchApi.search(query, options?)`, `searchApi.reembedAll()`, `SearchResultRow` |
| `src/pages/search/SearchPage.tsx` | New: search input, results list with document links |
| `src/components/layout/AppShell.tsx` | Modified: add Search to rail items and context panel |
| `src/App.tsx` | Modified: add `/search` route |

---

### Task 1: `document_chunks` table, migration, types, and chunking models

**DATABASE CHANGE: the executor must obtain the user's explicit yes before running `pnpm db:generate` and before committing the generated migration files under `apps/server/drizzle/`. Do not run the migration or commit it silently.**

**Files:**
- Create: `apps/server/src/modules/search/search.tables.ts`, `search.types.ts`, `search.models.ts`, `search.models.test.ts`
- Modify: `apps/server/src/modules/database/schema.ts`, `apps/server/src/modules/database/database.test.ts`
- Generate (after approval): `apps/server/drizzle/0006_document_chunks.sql`, snapshot, journal

**Interfaces:**
- Consumes: `documentsTable` from `../documents/documents.tables.js`; `drizzle-orm/sqlite-core` (`index`, `integer`, `sqliteTable`, `text`).
- Produces: `documentChunksTable`, `DocumentChunk`, `NewDocumentChunk`, `ChunkResult`, `SearchResult`, `EmbeddingJobPayload`, `newChunkId`, `chunkText(text, chunkSize?, overlap?)`, `escapeForFts5(query)`, `reciprocalRankFuse(vectorResults, keywordResults, k?, limit?)`. All consumed by Task 2 onward.

- [ ] **Step 1: Write the failing model tests**

`apps/server/src/modules/search/search.models.test.ts`:

Test cases for `chunkText`:
- Empty text produces zero chunks
- Text shorter than chunk size produces one chunk with correct start/end char offsets
- Multi-paragraph text splits at paragraph boundaries
- Long paragraph splits at sentence boundaries (period, question mark, exclamation mark)
- Very long sentence hard-cuts at the character limit (2000)
- Overlap: each chunk after the first starts with approximately 200 chars from the previous chunk's end
- `start_char` and `end_char` reference the primary content position in the original text (before overlap)
- `token_count` is `Math.ceil(chunkText.length / 4)`

Test cases for `escapeForFts5`:
- Simple words pass through
- Special characters (*, -, +, (, ), :, ^, ~) are escaped by wrapping tokens in double quotes
- Multi-word query escapes each token independently

Test cases for `reciprocalRankFuse`:
- Single result set returns RRF scores with k=60
- Two overlapping result sets sum their RRF scores for shared items
- Disjoint result sets interleave by score
- Result is sorted descending by fused score
- Respects the limit parameter

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- search.models`
Expected: FAIL, cannot find module `./search.models.js`.

- [ ] **Step 3: Write `search.tables.ts`**

`apps/server/src/modules/search/search.tables.ts`:
Define `documentChunksTable` with integer autoincrement PK, `document_id` text FK (cascade delete to `documentsTable`), `chunk_index` integer, `chunk_text` text, `token_count` integer, `start_char` integer, `end_char` integer, `created_at` text. Indexes on `(document_id)` and `(document_id, chunk_index)`. No `emb` column yet (added at runtime by the search module, decision 2).

- [ ] **Step 4: Re-export the new table from the shared schema**

In `apps/server/src/modules/database/schema.ts`, add: `export * from "../search/search.tables.js";`

- [ ] **Step 5: Write `search.types.ts`**

`apps/server/src/modules/search/search.types.ts`:
- `DocumentChunk = typeof documentChunksTable.$inferSelect`
- `NewDocumentChunk = typeof documentChunksTable.$inferInsert`
- `ChunkResult = { chunkIndex: number; chunkText: string; tokenCount: number; startChar: number; endChar: number }`
- `SearchResult = { chunkId: number; documentId: string; documentName: string; chunkText: string; chunkIndex: number; score: number; highlights: string }`
- `EmbeddingJobPayload = { documentId: string; userId: string }`
- `RankedItem = { id: number; score: number }` (used internally by RRF)

- [ ] **Step 6: Write `search.models.ts`**

Pure functions:
- `chunkText(text: string, chunkSize = 2000, overlap = 200): ChunkResult[]` -- the chunking algorithm from spec section 8.1
- `escapeForFts5(query: string): string` -- wraps each non-empty whitespace-delimited token in double quotes
- `reciprocalRankFuse(vectorResults: RankedItem[], keywordResults: RankedItem[], k = 60, limit = 10): RankedItem[]` -- the RRF algorithm from spec section 8.4

- [ ] **Step 7: Run the model tests**

Run: `pnpm --filter @docmind/server test -- search.models`
Expected: PASS, all describe blocks green.

- [ ] **Step 8: Add the D3 columns to `documents.tables.ts`**

Add to `documentsTable` in `apps/server/src/modules/documents/documents.tables.ts`:
- `summary: text("summary")` (nullable)
- `suggestedTitle: text("suggested_title")` (nullable)
- `summaryStatus: text("summary_status").notNull().default("pending")`
- `summaryError: text("summary_error")` (nullable)

Update `Document` and `NewDocument` types (they are inferred, so adding columns to the table definition updates them automatically). Update `listColumns` in `documents.repository.ts` to include the new columns. Update the `upload` method's document literal in `documents.usecases.ts` to include the new fields with their defaults (`summary: null, suggestedTitle: null, summaryStatus: "pending", summaryError: null`).

- [ ] **Step 9: Add a migration test that the new table and columns exist**

In `apps/server/src/modules/database/database.test.ts`, add tests:
- `document_chunks` table exists
- `documents` table has `summary`, `suggested_title`, `summary_status`, `summary_error` columns
- FTS5 virtual table `document_chunks_fts` exists
- FTS5 insert and delete triggers exist

These tests are expected to fail until Step 12 generates the migration.

- [ ] **Step 10: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 11: Stop and get the user's explicit yes before running the migration**

Show the user the table definitions and what the migration will contain. Do not proceed without an explicit yes.

- [ ] **Step 12: Generate the Drizzle migration**

Run from `apps/server`: `pnpm db:generate --name document_chunks`

Drizzle will generate the `document_chunks` table and the four new `documents` columns. After generation, hand-edit the migration SQL file to append the FTS5 virtual table and triggers as raw SQL (Drizzle does not support virtual tables):

```sql
--> statement-breakpoint
CREATE VIRTUAL TABLE `document_chunks_fts` USING fts5(
  chunk_text,
  content=document_chunks,
  content_rowid=id
);
--> statement-breakpoint
CREATE TRIGGER `document_chunks_fts_insert` AFTER INSERT ON `document_chunks`
BEGIN
  INSERT INTO `document_chunks_fts`(rowid, chunk_text) VALUES (new.id, new.chunk_text);
END;
--> statement-breakpoint
CREATE TRIGGER `document_chunks_fts_delete` AFTER DELETE ON `document_chunks`
BEGIN
  INSERT INTO `document_chunks_fts`(`document_chunks_fts`, rowid, chunk_text)
    VALUES('delete', old.id, old.chunk_text);
END;
```

Note: no UPDATE trigger is needed because chunks are never updated in place; they are deleted and reinserted on re-embed (spec review finding m4).

- [ ] **Step 13: Run the database and model tests**

Run: `pnpm --filter @docmind/server test -- database search.models`
Expected: PASS, including the migration tests from Step 9.

- [ ] **Step 14: Run the full server test suite**

Run: `pnpm --filter @docmind/server test`
Expected: PASS. The new columns on `documents` have defaults or are nullable, so existing tests should not break. If any test fails due to the new Document fields, fix the test by adding the defaults to its fixture data.

- [ ] **Step 15: Commit**

Only after Step 11's explicit yes.

```
feat(server): add document_chunks table, FTS5 index, chunking models, and D3 document columns

Creates the document_chunks table with integer PK, FTS5 virtual table
with content-sync triggers for keyword search, and the pure chunking and
RRF scoring functions the embedding pipeline and hybrid search will use.
Also adds summary, suggested_title, summary_status, summary_error columns
to the documents table for the upcoming D3 milestone.
```

---

### Task 2: Internal settings flag and `ai.embedding.activeDimension`

**Files:**
- Create: `apps/server/src/modules/search/search.settings.ts`
- Modify: `apps/server/src/modules/settings/settings.types.ts`, `apps/server/src/modules/settings/settings.usecases.ts`, `apps/server/src/modules/settings/settings.definitions.ts`, `apps/server/src/modules/settings/settings.usecases.test.ts`

**Interfaces:**
- Consumes: `SettingDefinition`, `defineSetting`, `createSettingsService`, `createSettingsRegistry`.
- Produces: `internal: boolean` on `SettingDefinition`, `setInternal(userId, key, value)` on the settings service, `searchSettingDefinitions` array. `listResolved` excludes internal settings. Public `set()` rejects internal keys.

- [ ] **Step 1: Add `internal` field to `SettingDefinition`**

In `apps/server/src/modules/settings/settings.types.ts`, add `internal?: boolean` to the type (default `false`). This is additive; every existing definition implicitly has `internal: false`.

- [ ] **Step 2: Update `defineSetting` to pass through the `internal` field**

In `apps/server/src/modules/settings/settings.registry.ts`, update `defineSetting` to include `internal: args.internal ?? false` in the returned object.

- [ ] **Step 3: Update `listResolved` to filter out internal settings**

In `apps/server/src/modules/settings/settings.usecases.ts`, change `listResolved` to filter: `registry.all().filter(d => !d.internal)`.

- [ ] **Step 4: Update public `set()` to reject internal keys**

In `apps/server/src/modules/settings/settings.usecases.ts`, at the start of the `set()` method's per-key loop (before the existing `clears` check), add:
```ts
if (definition.internal) {
  throw createError({ code: "settings.internal_only", message: `Setting "${key}" is managed internally and cannot be changed through the API`, status: 403 });
}
```

- [ ] **Step 5: Add `setInternal` method**

In `apps/server/src/modules/settings/settings.usecases.ts`, add a new method to the returned object:
```ts
async setInternal(userId: string, key: string, value: unknown) {
  const definition = registry.get(key);
  if (!definition.internal) {
    throw new Error(`setInternal called on non-internal setting "${key}"`);
  }
  const parsed = parseOrThrow(definition, value);
  await repository.upsert({ userId, key, isSecret: false, value: JSON.stringify(parsed) });
  cache.delete(userId);
}
```

- [ ] **Step 6: Write `search.settings.ts`**

`apps/server/src/modules/search/search.settings.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";

export const searchSettingDefinitions = [
  defineSetting({
    key: "ai.embedding.activeDimension",
    schema: v.pipe(v.number(), v.integer(), v.minValue(1)),
    internal: true,
    doc: "Dimension of the active embedding model. Set automatically by the embedding pipeline.",
  }),
];
```

- [ ] **Step 7: Register search settings in `allSettingDefinitions`**

In `apps/server/src/modules/settings/settings.definitions.ts`, import `searchSettingDefinitions` and spread them into `allSettingDefinitions`.

- [ ] **Step 8: Write tests for the internal settings behavior**

In `apps/server/src/modules/settings/settings.usecases.test.ts`, add tests:
- `listResolved` does not include internal settings
- Public `set()` rejects an internal key with `settings.internal_only`
- `setInternal()` writes and reads back the value
- `setInternal()` on a non-internal key throws

- [ ] **Step 9: Run tests and typecheck**

Run: `pnpm --filter @docmind/server test -- settings && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```
feat(server): add internal settings flag and ai.embedding.activeDimension

SettingDefinition gains an internal flag. Internal settings are hidden
from GET /api/settings and rejected by PUT /api/settings. The embedding
pipeline writes activeDimension through setInternal(), which bypasses
the public validation gate. First user: ai.embedding.activeDimension.
```

---

### Task 3: Search repository (chunks, FTS5, vectors)

**Files:**
- Create: `apps/server/src/modules/search/search.schemas.ts`, `apps/server/src/modules/search/search.repository.ts`

**Interfaces:**
- Consumes: `Database`, `documentChunksTable`, `documentsTable`, `NewDocumentChunk`, `sql` from drizzle-orm.
- Produces: `createSearchRepository({ db })` with `insertChunks(chunks, tx?)`, `deleteChunksByDocumentId(documentId, tx?)`, `findChunksByDocumentId(documentId)`, `searchFts5(query, limit, documentIds?)`, `ensureEmbeddingColumn(dimension)`, `hasEmbeddingColumn()`, `getEmbeddingColumnDimension()`, `setChunkEmbedding(chunkId, vectorJson)`, `setChunkEmbeddings(rows: {id, vectorJson}[])`, `searchByVector(queryVecJson, limit, documentIds?)`, `loadChunksWithDocuments(chunkIds)`.

- [ ] **Step 1: Write `search.schemas.ts`**

Valibot schemas:
- `embeddingJobPayloadSchema`: `{ documentId: v.string(), userId: v.string() }`
- `searchQuerySchema`: `{ q: v.pipe(v.string(), v.minLength(1)), documentIds: v.optional(v.string()), limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(50))) }` (parsed from query params, so limit is a string that transforms to number)
- `searchResultSchema`: for the API response shape

- [ ] **Step 2: Write `search.repository.ts`**

The repository combines Drizzle queries for the `document_chunks` table with raw SQL for FTS5 and vector operations.

Drizzle queries (use the typed table):
- `insertChunks(chunks: NewDocumentChunk[], tx?)`: batch insert
- `deleteChunksByDocumentId(documentId, tx?)`: delete where document_id = ?
- `findChunksByDocumentId(documentId)`: select ordered by chunk_index
- `loadChunksWithDocuments(chunkIds: number[])`: join chunks with documents to get document name and other metadata

Raw SQL queries (use `db.run(sql`...`)` and `db.all(sql`...`)`):
- `searchFts5(escapedQuery, limit, documentIds?)`: `SELECT rowid, rank, snippet(document_chunks_fts, 0, '<b>', '</b>', '...', 20) as highlights FROM document_chunks_fts WHERE document_chunks_fts MATCH ? ORDER BY rank LIMIT ?`. If `documentIds` is provided, add a subquery filter: `AND rowid IN (SELECT id FROM document_chunks WHERE document_id IN (...))`.
- `ensureEmbeddingColumn(dimension)`: check if `emb` column exists on `document_chunks` (via `PRAGMA table_info`), and if not, `ALTER TABLE document_chunks ADD COLUMN emb F32_BLOB(<dim>)`. If the column exists, check the dimension matches.
- `hasEmbeddingColumn()`: `PRAGMA table_info(document_chunks)` and check for `emb`.
- `getEmbeddingColumnDimension()`: parse from the column type string `F32_BLOB(n)`.
- `setChunkEmbedding(chunkId, vectorJson)`: `UPDATE document_chunks SET emb = vector(?) WHERE id = ?`.
- `setChunkEmbeddings(rows)`: batch the above in a loop (within a transaction).
- `searchByVector(queryVecJson, limit, documentIds?)`: `SELECT id, vector_distance_cos(emb, vector(?)) as distance FROM document_chunks WHERE emb IS NOT NULL ORDER BY distance LIMIT ?`. If `documentIds` is provided, add `AND document_id IN (...)`.
- `dropEmbeddingColumn()`: `ALTER TABLE document_chunks DROP COLUMN emb` (for dimension change reset; test this works in libsql 0.5.29 first, fallback is delete all rows).
- `clearAllEmbeddingStatuses(userId, tx?)`: updates all documents for a user to `embeddingStatus = 'pending'`, `embeddingError = null`.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```
feat(server): add search repository with chunk CRUD, FTS5 queries, and vector operations

Wraps Drizzle queries for document_chunks and raw SQL for FTS5 MATCH,
snippet, and libsql native vector_distance_cos. The embedding column is
managed at runtime via ALTER TABLE since its dimension depends on the
configured model.
```

---

### Task 4: Embedding pipeline (search usecases)

**Files:**
- Create: `apps/server/src/modules/search/search.usecases.ts`, `apps/server/src/modules/search/search.usecases.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3; `AiService`, `SettingsService`, `Database`, `JobHandler`, `asTxDb`.
- Produces: `createSearchService({ db, aiService, settingsService })` with `handler: JobHandler` (embedding), `search(userId, query, options?)`, `hasEmbeddingModel(userId)`, `reembedAll(userId)`.

- [ ] **Step 1: Write `search.usecases.ts`**

The search service:
- **`handler: JobHandler`** (embedding job):
  1. Parse payload with `embeddingJobPayloadSchema`.
  2. Load the document (via documents repository's `findById`). If not found, return (deleted between enqueue and execution).
  3. If extracted text is null or empty, set `embeddingStatus = 'done'` (decision 9) and return.
  4. Set `embeddingStatus = 'processing'`.
  5. Chunk the text with `chunkText()`.
  6. Delete any existing chunks for this document (re-embed is idempotent).
  7. Insert the new chunks into `document_chunks` (FTS5 triggers handle the index).
  8. Batch chunk texts into groups of 20, call `aiService.embed()` for each batch.
  9. After the first batch: check the dimension against `ai.embedding.activeDimension`. If the setting is unset, write it via `settingsService.setInternal()` and call `ensureEmbeddingColumn(dimension)`. If it differs and chunks exist, fail the job with a clear error (decision 11). If the column does not exist, create it.
  10. For each batch, update chunk embeddings via `setChunkEmbeddings`.
  11. Set `embeddingStatus = 'done'`, `embeddingError = null`.
  12. On error: set `embeddingStatus = 'pending'` (for retry), or `'failed'` on final attempt. Rethrow.

- **`search(userId, query, options?)`** (hybrid search):
  1. If `query` is empty, return empty results.
  2. Run FTS5 keyword search: `searchFts5(escapeForFts5(query), 20, options?.documentIds)`.
  3. If an embedding model is configured and embeddings exist: embed the query, run `searchByVector(queryVecJson, 20, options?.documentIds)`.
  4. If both result sets are non-empty, fuse with `reciprocalRankFuse()`. If only one, use that one.
  5. Load chunk metadata for the top results via `loadChunksWithDocuments()`.
  6. Return `SearchResult[]`.

- **`hasEmbeddingModel(userId)`**: check if `ai.model.embedding` is configured (not empty).

- **`reembedAll(userId)`**: enqueue an `embedding` job for every document with `extractionStatus = 'done'`. Set each document's `embeddingStatus = 'pending'`. Return the count.

- [ ] **Step 2: Write the integration tests**

`apps/server/src/modules/search/search.usecases.test.ts`:

Test setup: use `createTestApp` with fake adapter factories (same pattern as rules tests). The fake embed adapter returns fixed-dimension vectors.

Test cases:
- Embedding pipeline: upload a document with extracted text, enqueue and run an embedding job, verify chunks are created in `document_chunks`, verify FTS5 is searchable, verify `embeddingStatus = 'done'`.
- Zero-text document: empty extracted text produces zero chunks and `embeddingStatus = 'done'`.
- Re-embed idempotency: running the embedding job twice for the same document produces the same chunks (old ones deleted, new ones created).
- Dimension tracking: the first embed call sets `ai.embedding.activeDimension` via `setInternal`.
- Dimension mismatch: if `activeDimension` is set to a different value, the job fails with a clear error.
- Keyword-only search: FTS5 returns results when no embedding model is configured.
- Vector-only search: when query has no FTS5 matches, vector results alone are returned.
- Hybrid search: both FTS5 and vector results are fused with RRF.
- Scoped search: `documentIds` filter restricts both FTS5 and vector results.
- `reembedAll`: enqueues embedding jobs for all done documents.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @docmind/server test -- search.usecases`
Expected: PASS.

- [ ] **Step 4: Commit**

```
feat(server): add embedding pipeline and hybrid search

The embedding job chunks a document's text, embeds each batch through
the AI service's embedding slot, stores vectors as libsql native
F32_BLOB, and manages the embedding column dimension at runtime. Hybrid
search combines FTS5 keyword results with vector cosine distance results
using reciprocal rank fusion.
```

---

### Task 5: Wire embedding job into extraction and server

**Files:**
- Modify: `apps/server/src/modules/extraction/extraction.usecases.ts`, `apps/server/src/modules/extraction/extraction.usecases.test.ts`, `apps/server/src/server.ts`

**Interfaces:**
- Consumes: `SearchService` with `hasEmbeddingModel(userId)`.
- Produces: extraction handler enqueues `embedding` job alongside `rules` job; `embedding` handler registered on the job runner; `searchService` in the server return value.

- [ ] **Step 1: Extend `createExtractionService` to accept `searchService`**

Add `searchService: Pick<SearchService, "hasEmbeddingModel">` to the extraction service's constructor. In the success branch of `extractDocument`, after the existing `hasAutoItems` check and rules job enqueue:

```ts
const hasEmbedding = await searchService.hasEmbeddingModel(userId);
// Inside the same transaction:
if (hasEmbedding) {
  patch.embeddingStatus = "pending";
  await jobs.enqueue({ userId, type: "embedding", payload: { documentId, userId }, tx: txDb });
}
```

Also update the document patch to include `embeddingStatus: hasEmbedding ? "pending" : "done"`.

- [ ] **Step 2: Extend extraction failure to set `embeddingStatus` and `summaryStatus` to failed**

In the `isFinalAttempt` failure branch, add to the patch:
```ts
embeddingStatus: "failed",
embeddingError: "Extraction failed",
summaryStatus: "failed",
summaryError: "Extraction failed",
```

Per review major M3.

- [ ] **Step 3: Wire `searchService` in `server.ts`**

Import and create `searchService` after `aiService` and `settingsService` are available:
```ts
import { createSearchService } from "./modules/search/search.usecases.js";
const searchService = createSearchService({ db, aiService, settingsService });
```

Pass `searchService` to `createExtractionService`:
```ts
const extractionService = createExtractionService({ db, documentsService, settingsService, registry, rulesService, searchService });
```

Register the embedding handler on the job runner:
```ts
const jobRunner = createJobRunner({ db, handlers: { extraction: extractionService.handler, rules: rulesService.handler, embedding: searchService.handler } });
```

Add `searchService` to the `createServer` return value.

- [ ] **Step 4: Update extraction tests**

In `apps/server/src/modules/extraction/extraction.usecases.test.ts`:
- Verify that an `embedding` job is enqueued after successful extraction when an embedding model is configured.
- Verify that no `embedding` job is enqueued when no embedding model is configured.
- Verify that `embeddingStatus` and `summaryStatus` are set to `'failed'` on final extraction failure.

- [ ] **Step 5: Run the full server test suite and typecheck**

Run: `pnpm --filter @docmind/server test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
feat(server): chain embedding job from extraction and register on job runner

After extraction completes, an embedding job is enqueued when an
embedding model is configured. Both jobs run independently through the
sequential job runner. Extraction failure now also fails embedding and
summary statuses on the final attempt.
```

---

### Task 6: Search API routes

**Files:**
- Create: `apps/server/src/modules/search/search.routes.ts`, `apps/server/src/modules/search/search.routes.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Consumes: `SearchService`, `getUserId`, Hono `app`.
- Produces: `GET /api/search?q=<query>&documentIds=<comma-separated>&limit=<n>`, `POST /api/search/reembed-all`.

- [ ] **Step 1: Write `search.routes.ts`**

```ts
registerSearchRoutes({ app, searchService, getUserId })
```

`GET /api/search`:
- Parse query params with `searchQuerySchema`.
- Call `searchService.search(userId, q, { documentIds, limit })`.
- Return `{ results, query, total }`.

`POST /api/search/reembed-all`:
- Call `searchService.reembedAll(userId)`.
- Return `{ count }` (number of jobs enqueued).

- [ ] **Step 2: Register routes in `server.ts`**

After the existing `registerRulesRoutes` call, add:
```ts
registerSearchRoutes({ app, searchService, getUserId });
```

- [ ] **Step 3: Write route tests**

`apps/server/src/modules/search/search.routes.test.ts`:
- `GET /api/search?q=rent` returns results when chunks exist.
- `GET /api/search` without `q` returns 400.
- `GET /api/search?q=rent&documentIds=doc_123` restricts to that document.
- `GET /api/search?q=rent&limit=2` returns at most 2 results.
- `POST /api/search/reembed-all` returns a count.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @docmind/server test -- search && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```
feat(server): add search API routes

GET /api/search runs hybrid search (keyword + vector with RRF).
POST /api/search/reembed-all enqueues embedding jobs for all extracted
documents. Both require authentication.
```

---

### Task 7: Client search API and search page

**Files:**
- Create: `apps/client/src/lib/search-api.ts`, `apps/client/src/pages/search/SearchPage.tsx`
- Modify: `apps/client/src/App.tsx`, `apps/client/src/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `api.get`, `useQuery`, `useState`, React Router.
- Produces: `/search` page with input, results, and document links.

- [ ] **Step 1: Write `search-api.ts`**

```ts
import { api } from "./api.js";

export type SearchResultRow = {
  chunkId: number;
  documentId: string;
  documentName: string;
  chunkText: string;
  chunkIndex: number;
  score: number;
  highlights: string;
};

export type SearchResponse = {
  results: SearchResultRow[];
  query: string;
  total: number;
};

export const searchApi = {
  search(query: string, options?: { documentIds?: string[]; limit?: number }): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.documentIds?.length) params.set("documentIds", options.documentIds.join(","));
    if (options?.limit) params.set("limit", String(options.limit));
    return api.get(`/api/search?${params}`);
  },
  reembedAll(): Promise<{ count: number }> {
    return api.json("POST", "/api/search/reembed-all", {});
  },
};
```

- [ ] **Step 2: Write `SearchPage.tsx`**

A simple search page:
- Text input for the query.
- Search button (or Enter to submit).
- Results list: each result shows the document name, a chunk excerpt (using the `highlights` field with HTML sanitized), the relevance score as a subtle percentage, and links to the document detail page.
- Empty state: "Search your documents by keyword or meaning."
- Loading state while the search is in flight.
- No results state: "No results found for '<query>'."

The search uses `useQuery` with `enabled: !!query` so it only fires when there is a query. Alternatively, use a `useMutation` approach where the search is triggered on form submit. The simpler approach is a controlled form that updates a `query` state on submit, and a `useQuery` keyed on that state.

- [ ] **Step 3: Add `/search` to the router**

In `apps/client/src/App.tsx`:
- Import `SearchPage`.
- Add `<Route path="/search" element={<SearchPage />} />` inside the `AppShell` routes, between `/sorting` and `/jobs`.

- [ ] **Step 4: Add Search to the sidebar**

In `apps/client/src/components/layout/AppShell.tsx`:
- Import `Search` icon from `lucide-react`.
- Add a new `RailTab` value `"search"`.
- Add a rail item: `{ tab: "search", label: "Search", to: "/search", icon: Search }`, inserted between "files" and "tags" in the `railItems` array.
- Update `tabForPath` to handle `/search`.
- Add a `SearchPanel` component (simple: heading "Search", link to the search page).

- [ ] **Step 5: Run client tests and typecheck**

Run: `pnpm --filter @docmind/client test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```
feat(client): add search page with hybrid keyword and vector search

Search page at /search with a query input and results list. Each result
shows the document name, highlighted excerpt, and a link to the
document. Added to the sidebar rail between Files and Tags.
```

---

### Task 8: End-to-end verification and test hardening

**Files:**
- Modify: any file with test gaps found during verification

**This task is not a separate commit unless fixes are needed. Its purpose is verification.**

- [ ] **Step 1: Run the full test suites**

```bash
pnpm --filter @docmind/server test
pnpm --filter @docmind/client test
pnpm typecheck
```

All must pass.

- [ ] **Step 2: Manual acceptance test**

Start the dev server (`pnpm dev`). Upload a document with meaningful text content. Verify:
1. After extraction completes, an `embedding` job appears in the Jobs page.
2. The embedding job completes and the document's `embeddingStatus` becomes `done`.
3. Navigate to the Search page and search for a keyword from the document. Results appear.
4. If an embedding model is configured, the search uses hybrid (both keyword and vector). If not, keyword-only.
5. Clicking a search result navigates to the document detail page.
6. The Settings page does not show `ai.embedding.activeDimension`.

- [ ] **Step 3: Verify cascade delete**

Delete a document through the UI. Verify that its chunks are removed (the FTS5 index no longer returns results for that document's content). This is automatic through ON DELETE CASCADE.

- [ ] **Step 4: Fix any issues found, commit if needed**

If any issues are found, fix them and commit with an appropriate message.

## Verification checklist

Before marking D1 complete, every item must be confirmed:

- [ ] `document_chunks` table exists with correct schema
- [ ] FTS5 virtual table and triggers exist and work
- [ ] Chunking produces correct chunks with boundary awareness and overlap
- [ ] FTS5 search returns ranked results with snippets
- [ ] Embedding job runs after extraction when a model is configured
- [ ] Embeddings are stored as libsql native F32_BLOB on the chunks table
- [ ] `ai.embedding.activeDimension` is set by the first embed and hidden from the API
- [ ] Vector search returns results ordered by cosine distance
- [ ] Hybrid search fuses FTS5 and vector results with RRF
- [ ] Fallback: keyword-only when no embedding model is configured
- [ ] Fallback: vector-only when FTS5 returns no results
- [ ] Zero-text documents complete with `embedding_status = 'done'`
- [ ] Extraction failure sets `embedding_status` and `summary_status` to `'failed'`
- [ ] Document deletion cascades to chunks, FTS5 index, and embeddings
- [ ] `POST /api/search/reembed-all` enqueues jobs for all extracted documents
- [ ] Search page shows results with document links
- [ ] Settings page does not expose internal settings
- [ ] All tests pass, typecheck clean

## Risks

1. **`ALTER TABLE DROP COLUMN` in libsql.** SQLite (and by extension libsql) has restrictions on `ALTER TABLE DROP COLUMN`. If it fails for the `emb` column (e.g., because it is referenced by triggers or indexes), the dimension-change reset will need to delete all chunk rows instead and let re-embedding recreate them. The embedding column would be re-added with the new dimension on the next embed. This is tested in Task 3 and the fallback is straightforward.

2. **FTS5 in migration with raw SQL.** The FTS5 virtual table and triggers must be hand-appended to the Drizzle-generated migration. If the executor forgets, the migration test from Task 1 Step 9 will catch it.

3. **Vector search performance at scale.** Brute-force cosine distance over `F32_BLOB` columns scans every non-null row. For a single-user app with a few thousand chunks, this is fast (tested). If a user accumulates tens of thousands of chunks, an ANN index can be added without schema changes.

4. **Embedding API costs for bulk re-embed.** Re-embedding all documents sends every chunk through the API. The UI's re-embed action should show a count before confirming.
