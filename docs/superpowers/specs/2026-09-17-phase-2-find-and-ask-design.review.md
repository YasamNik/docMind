# Review: Phase 2 (Find and Ask) design spec

Reviewed on 2026-09-17. Reviewer: plan-reviewer agent.
Spec: `docs/superpowers/specs/2026-09-17-phase-2-find-and-ask-design.md`.
Checked against: `DOCMIND-DESIGN.md`, `CLAUDE.md`, and the current server modules
(`settings`, `database`, `jobs`, `documents`, `extraction`, `ai`). Where the spec makes a
factual claim about a third-party package, I inspected the installed package in
`node_modules` rather than trusting the claim, since this is exactly the kind of thing
that is cheap to verify before a spike burns a day on it.


## Blocking

### B1. The sqlite-vec loading plan (decision 13) will not work as written, and the fallback list is missing the option that actually fits this stack

Decision 13 says the extension is "loaded via the client's constructor or a PRAGMA." I
checked `@libsql/client@0.18.0` and `libsql@0.5.29` (the versions in this repo's
lockfile):

- `Client` (what `createClient()` returns) has no `loadExtension` method anywhere in its
  public surface (`@libsql/core/lib-esm/api.d.ts`). Nothing in `Config` accepts an
  extension path either. There is no constructor option and no PRAGMA that loads a
  native extension through the public API.
- The `loadExtension` method exists only on the raw `libsql` native `Database` object
  (`libsql/types/promise.d.ts`), which `@libsql/client`'s node/file-mode driver
  (`lib-esm/sqlite3.js`) wraps internally and never exposes.
- Worse, that wrapper is a **connection pool**, not a single connection. `ConnectionPool`
  (`sqlite3.js`) creates a new raw `Database` lazily on every borrow once the pool is
  below `maxConnections`, and `maxConnections = isInMemory ? 1 : Math.max(1, config.concurrency)`.
  `@libsql/core/config.js` defaults `concurrency` to **20** when unset. `database.ts`
  calls `createClient({ url })` with no `concurrency` option, so a file-backed DocMind
  database can silently open up to 20 separate raw connections under concurrent request
  load, each a fresh, un-initialized `Database`.

Two consequences:

1. Even if a workaround were found to call `loadExtension` on one connection (e.g. by
   reaching into `@libsql/client` internals, which is itself fragile across versions),
   it would only be loaded on whichever connection handled that one call. Any later
   request that gets a different pooled connection would fail with "no such module:
   vec0" the first time it touched the vec table. This isn't a one-time spike risk, it's
   an intermittent-in-production risk that unit tests will never catch, because tests run
   against `:memory:`, which is forced to `maxConnections = 1` regardless of the
   `concurrency` setting.
2. This same pooling behavior means the existing `PRAGMA foreign_keys = ON` in
   `createDatabase()` (`database.ts` line 9) is **also** only guaranteed on whichever
   connection happened to run first. Under concurrent load in production, a second pooled
   connection is created with SQLite's default `foreign_keys = OFF`, silently defeating
   the `ON DELETE CASCADE` foreign keys the Milestone C review required (`document_tags`,
   `sort_evaluations`, and this spec's own `document_chunks` and `chat_messages`). This is
   a pre-existing Phase 1 bug that this spec's own cascade assumptions (section 5.4)
   depend on, and it has been invisible so far only because tests use `:memory:` and
   local dev traffic is low-concurrency enough that the pool rarely grows past one
   connection.

Fix, in order of preference:

- **Force single-connection mode now**, regardless of which vec approach is chosen: add
  `concurrency: 1` to the `createClient({ url })` call in `database.ts`. This is a one-line
  change that makes the runner comment ("the libsql client is a single connection") true
  instead of assumed, closes the foreign-key gap, and makes any future extension-loading
  workaround actually safe. This should land as a small Phase 1 fix before or alongside
  D1's first commit, not be left as a byproduct of the vec spike.
- For the vec table itself, do not spike three undirected options. Check **libsql's native
  vector support** first (an `F32_BLOB(n)` column type and `vector_distance_cos` /
  `vector_top_k` functions built into libsql itself, no extension loading required, no
  second driver). This sidesteps the whole loadExtension problem, since built-in SQL
  functions work on every pooled connection automatically. Confirm the vector column
  type and functions exist in the exact `libsql` version pinned here (0.5.29) before
  committing to `sqlite-vec` at all. Only fall back to a second `better-sqlite3`
  connection (option a) if libsql's native vectors are unavailable or too limited (no ANN
  index, brute-force only past some row count) for this scale, and note that running two
  SQLite drivers against the same file adds real operational complexity (two connection
  lifecycles, two places PRAGMAs must be set) for a single-user app, which cuts against
  "simplicity beats generality."

The spec should not present this as three equally-weighted options resolved by a 30
minute spike. Two of the three (loadExtension via the client, or via a bare PRAGMA) are
already ruled out by reading the installed package.

### B2. `ai.embedding.activeDimension` has no way to stay hidden or protected in the current settings module

Section 5.3 calls this "a system setting, not shown in the UI... not user-editable." The
settings module has no such concept today:

- `SettingDefinition` (`settings.types.ts`) has no `hidden`/`internal` flag.
- `listResolved()` (`settings.usecases.ts`) returns every registered definition
  unconditionally; `GET /api/settings` (`settings.routes.ts`) returns whatever
  `listResolved` returns with no filtering.
- `updateSettingsBodySchema` (`settings.schemas.ts`) is `{ updates: v.record(v.string(),
  v.unknown()) }`, i.e. any key string. The only gate before a write reaches the database
  is `registry.get(key)` succeeding and the per-key schema passing.

So as specified, `ai.embedding.activeDimension` must still be registered as a normal
`SettingDefinition` for the embedding pipeline's own `settingsService.set()` call to
succeed, which means it is registered, which means it is returned by `GET
/api/settings` and writable by `PUT /api/settings` with `{ updates: {
"ai.embedding.activeDimension": 42 } }`. Nothing stops a stray client bug, or a user
poking the API, from setting this to a wrong value, and per B3 below, whatever the wrong
value is next gets treated as authoritative and can trigger a full vec table wipe.

Fix: add an `internal: boolean` field to `SettingDefinition` (default false). Filter
internal settings out of `listResolved` entirely (or at minimum out of the route
response), and have `settingsService.set()` reject any key marked internal when called
through the public API path. Give the embedding pipeline a separate write path (a
`setInternal` method on the settings service, or a direct repository call) that bypasses
the public `set()`. This is a small addition but it is new capability the current module
does not have, so it belongs in the spec's module-changes list (section 6.3), not left
implicit.


## Major

### M1. A per-document embedding job can drop and recreate the shared vec table

Section 8.2 step 6: "check the returned dimension against `ai.embedding.activeDimension`.
If it differs (or the setting is unset), update the setting and recreate the vec table
with the new dimension." This runs inside the ordinary per-document embedding job, the
same job that runs for every single upload. In steady state this branch never fires
(the model hasn't changed, so the dimension always matches), but the design doc is
explicit that changing the embedding dimension is supposed to be a rare, confirmed,
user-initiated action ("The UI warns that every document will be re-embedded and asks to
confirm"). Here, the same destructive action (drop and recreate `vec_chunks`, which
deletes every other document's vectors, not just this one's) is reachable from a
routine background job, gated only by comparing against a setting value that (per B2) is
not protected from external tampering and (per this section) could be stale due to
in-memory settings caching, a restart race, or any bug in the reset workflow. If it
misfires, the blast radius is total: every document's search index, silently, with no
confirmation and no log a user would see.

Fix: separate "detect a mismatch" from "recreate." The routine per-document path should
never recreate a non-empty table; if `ensureVecTable` is asked for a dimension that
doesn't match an existing, non-empty vec table, that is a bug or a missed reset, and the
job should fail loudly (mark this document's embedding failed with a clear error)
rather than wipe shared state. Reserve the actual drop-and-recreate call for the
dedicated settings-triggered reset workflow (decision 14), which already knows it is
doing a deliberate wipe and has already cleared `activeDimension` and the chunks table
before any job runs. The only place `ensureVecTable` should legitimately create the table
from nothing is when the vec table plain does not exist yet (first embed ever, or right
after that dedicated reset), which is a distinguishable case (table absent) from
"dimension mismatch on an existing table" (which should be an error).

### M2. Deleting a vec row when a document is deleted is asserted, not wired

Section 5.4: "Deleting a document cascades to its `document_chunks` rows... The search
module also deletes the matching vec rows." Section 6.3 (module changes) lists no change
to `documents.usecases.ts` or `documents.repository.ts` for this, and
`documents.repository.remove()` today is a single `db.delete(documentsTable).where(...)`
that relies entirely on `ON DELETE CASCADE` (confirmed by reading the file). `vec0`
virtual tables cannot be FK targets, so there is no cascade path from `document_chunks`
to `vec_chunks`, and nothing in the spec calls the search module before or after a
document delete. Left as written, every document deletion leaks rows in `vec_chunks`
forever: dead weight in the vector index, and it will quietly degrade search relevance
over time as stale embeddings for deleted documents keep scoring in KNN results (the
join back to `document_chunks` metadata would filter the row out of the final response,
so this fails safe rather than crashing, but the leak itself never gets fixed).

Fix: mirror the FTS5 approach instead of adding a cross-module callback. Add a raw-SQL
trigger, created at runtime alongside the vec table (in `ensureVecTable`, since the vec
table itself is runtime-managed): `AFTER DELETE ON document_chunks -> DELETE FROM
vec_chunks WHERE rowid = old.id`. This keeps the vec table self-cleaning through the
same cascade that already cleans `document_chunks`, and it means the documents module
never needs to know the search module exists. One process note: this trigger must be
recreated every time `dropVecTable`/`ensureVecTable` recreate the table (same document
already true for the vec table itself), and the plan should keep the drop-then-recreate
window as short as possible since a document delete that lands in that window would hit
"no such table: vec_chunks."

### M3. Extraction failure does not fail `embedding_status` or `summary_status`

`extraction.usecases.ts`'s failure branch (confirmed by reading the file) already sets
`ruleStatus: 'failed'` on a final attempt, a fix from the Milestone C review (B2:
"Documents with failed extraction appear in Inbox forever"). This spec adds two more
status columns gated on extraction succeeding (`embedding_status`, `summary_status`,
both default `'pending'`) but does not extend that same failure branch to them. A
document whose extraction fails permanently will sit forever with
`embedding_status = 'pending'` and `summary_status = 'pending'`, with no job ever
enqueued to move them, which is the exact same bug class the Milestone C review already
found and fixed for `rule_status`. It also directly undermines open question 3 (bulk
"embed all pending documents"): that action would try to embed documents that have no
extracted text and fail loudly for every one of them.

Fix: in the same final-attempt branch, set `embeddingStatus: 'failed'` and
`summaryStatus: 'failed'` alongside `ruleStatus: 'failed'`.

### M4. No stated behavior when the assistant's response fails mid-stream

Section 10.1 step 1 saves the user message before generation starts; step 10 saves the
assistant message "after the stream ends." Risk 5 covers a client-side connection drop
but not a server-side failure (model error, rate limit, retrieval failure) after the user
message is already committed. As written, that failure leaves a user turn in the
session's history with no reply, ever, and no stated way to retry it: the client showed
whatever text streamed before the error (event: error), but nothing was persisted, so a
page refresh loses even that. This is a real gap for a feature whose entire value is a
reliable conversation history.

Fix: on any generation error, save an assistant message anyway (fixed content noting the
failure, or a `content` explaining the error), so the session never has a dangling
unanswered user turn, and the client can offer a retry against that turn. State this
explicitly in section 10.1 and the API section's error event description.

### M5. Undocumented departures from the design doc's stated retrieval numbers

`DOCMIND-DESIGN.md`'s Search and Chat section is specific: "Vector search for the top 10
chunks... Merge with reciprocal rank fusion. Assemble the top 5 chunks as context." This
spec changes both numbers without listing them in section 4 (Departures): decision 5 caps
each result set at 20 before fusion (not 10), and section 10.1 step 4 assembles the top 8
chunks as chat context (not 5). These may well be better numbers, but the same review
standard applied to Milestone C (M1: "setting key naming is a silent departure... must be
listed") applies here. Add both to section 4.


## Minor

### m1. `search.defaultLimit` setting appears to be dead configuration

Section 5.3 defines `search.defaultLimit` (integer, default 10) as a user-facing setting.
Section 7.1 separately states the search API "`limit` defaults to 10, max 50" with no
mention of reading this setting. As written, the setting exists, is presumably shown on
the Settings page, and does nothing. Either wire `GET /api/search` to read
`search.defaultLimit` as its default, or drop the setting. Given "config for things that
never vary" is a review criterion and this is a single-user app with a query-param
override already available, dropping it is the simpler choice.

### m2. SSE over POST needs a stated client strategy

The native browser `EventSource` API only supports `GET` requests with no custom body,
so it cannot consume `POST /api/chat/sessions/:id/messages`'s SSE stream. The spec should
say the client parses SSE frames manually from a `fetch()` `ReadableStream` (or names a
small parsing helper), so the plan doesn't assume `new EventSource(...)` will work.

### m3. D3 is called "independent" but its schema is not

Section 2 describes D3 as "independent of both" D1 and D2, but section 13 bundles D3's
four `documents` columns into D1's migration (`0006_document_chunks`) "because D3 is
small and the columns do not break anything." That means D3 cannot actually ship before
D1's migration lands, even though its logic has no runtime dependency on search. The
delivery order already places D1 first, so this doesn't block anything in practice, but
section 2's wording should say "D3 depends on D1's migration having landed, though not on
search functionality" rather than "independent."

### m4. No FTS5 UPDATE trigger, and the spec doesn't say why

Decision 3's triggers cover insert and delete only. This is correct given decision that
chunks are always deleted and reinserted on re-embed (8.2 step 3), never updated in
place, but the spec should say so explicitly in section 5.4's rules, so a future reader
doesn't wonder if the UPDATE trigger was forgotten.

### m5. `accept-title` behavior is undefined when there is no suggestion

`POST /api/documents/:id/accept-title` (section 7.3, 9.4) doesn't say what happens when
`suggested_title` is null (summary not yet run, failed, or already accepted once). State
whether this is a 400 or a no-op.

### m6. Suggested-title nagging after a manual rename

Any re-extraction (including a user-triggered retry) re-enqueues `summarize` per section
6.3, which overwrites `suggested_title` with a fresh AI value. Section 9.3's suppression
rule only hides the badge when the new suggestion happens to match the current name
exactly. If a user already renamed the document deliberately and a later re-extraction
proposes a different title, the badge reappears with no way to permanently dismiss
suggestions for that document. Low severity (cosmetic nag, not data loss), worth a
one-line acknowledgment or a per-document "don't suggest again" flag if it turns out to
bother the one user of this app.

### m7. Section 13 presupposes an answer to open question 3

"Existing documents with `embedding_status = 'pending'` will naturally be picked up by a
bulk re-embed if the user runs one" assumes the bulk-embed feature from open question 3
exists, before that question is resolved. See ruling 3 below; update section 13 once
decided.


## Rulings

Per the autonomy rule, settling the spec's four open questions plus the implementation
choices raised above.

1. **sqlite-vec integration approach.** Do not spend the spike on the client-constructor
   or PRAGMA paths (B1 shows both are unavailable through `@libsql/client`'s public
   surface). Spend it confirming libsql's native vector column type and functions in the
   pinned `libsql@0.5.29`. Fall back to a second `better-sqlite3` connection only if that
   is insufficient. Force `concurrency: 1` on the libsql client regardless of which path
   is chosen (fixes the foreign-key gap either way).

2. **Default embedding model.** Keep `openai/text-embedding-3-small`. Matches the existing
   cost-conscious default pattern (the rules and chat slots already default to flash-tier
   models, not the largest available). The large model is a manual opt-in later, gated by
   the existing confirmed destructive re-embed flow.

3. **Bulk embedding of existing documents.** Option (a): a manual "Embed all documents"
   action on the search page. Not automatic on server start. Reason: silently running
   paid API calls on every restart after the migration is a surprising cost, and combined
   with M1's blast-radius concern, an explicit, visible, user-initiated action is safer
   than an implicit one.

4. **Chat history length.** Keep 10 messages, not configurable. Reason: YAGNI for a
   single-user app; adjust the constant later if it proves wrong.

5. **Vec row cleanup on document delete (M2).** Use a runtime-created
   `AFTER DELETE ON document_chunks` trigger that deletes the matching `vec_chunks` row,
   not a cross-module callback. Reason: keeps the documents module unaware that search
   exists, consistent with the FTS5 trigger already chosen for the same problem.

6. **Vec table recreation blast radius (M1).** The per-document embedding job may create
   the vec table when it does not exist, but must never drop-and-recreate an existing,
   non-empty one; that path is reserved for the explicit settings-triggered reset. A
   dimension mismatch against a non-empty table fails the job instead of wiping it.

7. **Internal settings (B2).** Add `internal: boolean` to `SettingDefinition`, filtered
   from `listResolved` and rejected by the public `set()` path. `ai.embedding
   .activeDimension` is the first user of this flag.


## Edge cases the plan must address

1. **Vec table drop/recreate racing a document delete.** If the M2 trigger is recreated
   together with the vec table on every reset, keep the window between drop and recreate
   as short as possible; a delete landing in that window hits "no such table."

2. **Session deleted mid-stream.** If a chat session is deleted while an assistant
   response is still streaming, the final message insert (step 10) references a
   `session_id` that no longer exists. State that this surfaces as an ordinary insert
   error to that in-flight request; no special handling needed beyond not silently
   swallowing it.

3. **Stale `document_scope` ids.** A chat session's `document_scope` can reference a
   document deleted after the session was created. Retrieval must skip missing ids
   rather than error.

4. **Zero-chunk documents.** Empty `extracted_text` produces zero chunks (8.1) and the
   embedding job still sets `embedding_status = 'done'` with nothing to insert; state
   this explicitly is expected, not a failure, so it doesn't look like a bug during
   manual testing.


## Delivery order assessment

D1 first is the right call: it carries the only real technical-risk item (vector search
integration), so de-risking it before the smaller, independent D3 is sound even though
the spec's own "independent" framing for D3 doesn't quite hold once the migration
bundling in m3 is accounted for. D2 depending on D1 and D4 depending on D3 and C3 are
both correctly ordered. No change to the sequence is needed.


## Verdict

**Ready after fixing:**

1. Replace decision 13 with a directed sqlite-vec plan per ruling 1, and force
   `concurrency: 1` on the libsql client (B1).
2. Add the `internal` setting flag and use it for `ai.embedding.activeDimension` (B2,
   ruling 7).
3. Bound the vec-table-recreate path to non-destructive cases only (M1, ruling 6).
4. Add the vec-row cleanup trigger for document deletion (M2, ruling 5).
5. Extend the extraction failure branch to fail `embedding_status` and `summary_status`
   (M3).
6. State what happens to the conversation when generation fails mid-stream (M4).
7. Add the RRF cap and chat context-size departures to section 4 (M5).

None of these require redesigning the feature. The chunking, hybrid search, RAG prompt,
summarize pipeline, and inbox triage approaches are all sound and appropriately simple.
The issues above are concentrated in three places: what actually works with the
installed database driver, what happens when a rare-in-normal-operation branch misfires,
and a few undocumented departures from the parent spec's numbers.
