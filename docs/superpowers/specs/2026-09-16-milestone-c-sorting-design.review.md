# Review: Milestone C (Sorting) design spec

Reviewed on 2026-09-16. Reviewer: plan-reviewer agent.
Spec: `docs/superpowers/specs/2026-09-16-milestone-c-sorting-design.md`.
Checked against: `DOCMIND-DESIGN.md`, parent spec, every existing module
listed in the review request.


## Blocking

### B1. Document deletion does not cascade to new tables

`documents.repository.remove` (line 69) deletes the document row with no
cascade. After C2 and C3, `document_tags` and `sort_evaluations` reference
`document_id`. Without ON DELETE CASCADE or application-level cleanup, deleting
a document leaves orphan rows in both tables. The proposals API would return
proposals for deleted documents, and `document_tags` rows would inflate tag
counts.

Fix: either (a) add ON DELETE CASCADE foreign keys in the C2 and C3 migrations,
or (b) add explicit deletes in `documentsService.remove` before deleting the
document. Option (a) is simpler and self-maintaining. Whichever is chosen, the
spec must state it.

### B2. Documents with failed extraction appear in Inbox forever

`rule_status` defaults to `pending` (documents.tables.ts line 16). If
extraction fails, `rule_status` is never updated and stays `pending`. The
Inbox filter (spec section 5, line 139) is `rule_status` is `pending` or
`processing`. So a document whose extraction failed sits in Inbox permanently,
but sorting can never run because there is no text.

Fix: either (a) when extraction fails, set `rule_status` to `failed` too, or
(b) define Inbox as `rule_status IN ('pending','processing') AND
extraction_status = 'done'`. Option (a) is simpler and keeps the status
columns honest. The extraction failure handler in C3 must set both
`extraction_status` and `rule_status`.


## Major

### M1. Setting key naming is a silent departure from the design doc

Design doc uses `ai.models.rules`, `ai.models.chat`, `ai.models.embedding`
(plural, dot-separated `models`), and `ai.providers.openrouter.apiKey`.
Spec section 7.1 uses `ai.model.rules` (singular) and `ai.openrouter.apiKey`
(no `providers` segment). The env var names in the design doc (`AI_RULES_MODEL`)
match both, but the setting keys differ. This is not listed in the Departures
section (section 4). Either add a fourth departure bullet or align the spec with
the design doc keys.

### M2. Incomplete Departures section: `applied_by_rule` renamed, cleanup logic simplified, capability flags extended

Three further departures from the design doc are not listed in section 4:

1. `document_tags.applied_by_rule` in the design doc is renamed to
   `applied_by_auto` in the spec. Although the table is new, the design doc
   text must be updated to match.
2. The design doc's complex cleanup rule ("applied_by_rule is set to 0 only
   when no remaining active rule with a passing evaluation targets that tag")
   is replaced by the proposal-based cleanup in section 9.6. This is a
   significant logic change.
3. The design doc's capability flags are `text, embeddings, model listing`.
   The spec adds `structured`. Since the adapter interface gains a
   `generateStructured` method that not every provider may support, this is a
   real interface change.

Fix: add these to section 4 and mark the design doc for update in the last
plan.

### M3. `category_source` is not set explicitly for initial mode

Section 9.3 says the category is set for the highest-confidence match, but
does not say what `category_source` is set to. Section 9.5 mentions
`source 'auto'` for proposals, and section 8.1 says the manual route sets
`source 'manual'`. But initial mode (the first-run path that directly applies
results) never says `auto`. The plan writer would have to guess.

Fix: add "with `category_source = 'auto'`" to section 9.3.

### M4. Prompt size is unbounded

Each tag description is up to 300 characters, each category description up to
2000 characters, document text is 8000 characters. With 50 auto tags and 20
auto categories, the prompt payload is roughly 50*350 + 20*2050 + 8000 =
66500 characters, well over 15K tokens. Some models (smaller Ollama models,
older OpenRouter models) will reject this.

Fix: the spec should set a practical limit, for instance cap the total prompt
at a character count derived from the rules model's context length, or cap the
number of items sent per call and warn in the UI when the user exceeds it.
A simpler first step: document the known limitation and emit a warning log when
the prompt exceeds a threshold (e.g. 40K chars).

### M5. Dismissed-proposal sameness uses `updated_at`, which changes on rename and other metadata edits

Section 9.4 decides sameness by comparing `item.updated_at` and
`document.updated_at` against the dismissed evaluation's `evaluated_at`.
`document.updated_at` changes on rename (documents.usecases.ts line 109),
category assignment, and tag changes, not just text changes. So a dismissed
proposal is re-offered after any metadata edit. This is noisy but not
catastrophic.

Acknowledgment requested: either (a) accept this trade-off and note it in the
spec, or (b) compare `document.content_hash` plus `item.updated_at` instead,
since `content_hash` changes only when the file content changes. Option (b) is
a small improvement for low cost.


## Minor

### m1. `sort_evaluations.job_id` is nullable but dry runs are never stored

Section 5 says `job_id` is nullable with the note "null for dry runs (dry
runs are not stored)". If dry runs are never stored, the column is always
non-null in practice. Make the column NOT NULL to match reality and simplify
queries.

### m2. `sort_evaluations(outcome)` index has low cardinality

Five possible values. The proposals query needs `WHERE outcome = 'proposed'`,
which is better served by a composite index `(outcome, document_id)`. Replace
the single-column index.

### m3. Tag ordering is unspecified

Categories have `sort_order`. Tags do not. The spec does not say how tags are
ordered in API responses or the UI. A plan writer would have to choose between
alphabetical, creation order, or manual order.

### m4. Category and tag name uniqueness enforcement is unspecified at the DB level

Section 5 says names are "unique among siblings, case-insensitive" for
categories and "unique per user, case-insensitive" for tags. The migration must
enforce this with a unique index using COLLATE NOCASE, or the application must
check before insert/update. The spec should state which.

### m5. `GET /api/ai/providers` response shape mixes per-provider and global data

Section 7.4 says the response includes per-provider data (`keySet`,
`keyLastFour`, `baseUrl`) and global data (three slot values). The spec should
clarify whether slots are a top-level field or repeated per provider.

### m6. Provider error text may contain credentials

Section 7.2 says adapter errors include the provider's error text verbatim.
Some providers echo parts of the key in error messages. The adapter should
strip known key prefixes (e.g., `sk-`, `or-v1-`) from error text before
wrapping in AppError.

### m7. Category path in list response requires tree traversal

`GET /api/categories` returns `path`. `GET /api/documents` list rows gain
`categoryPath`. Computing paths requires walking the parent chain. With the
"no raw SQL outside migrations" convention, this must be done in application
code by loading all categories and building paths in memory. The spec should
say so, or explicitly permit a recursive CTE for this query.

### m8. `POST /api/sort/run` lacks a `targetType`/`targetId`-less mode

Section 9.7 requires `targetType` and `targetId`. There is no way to rerun
all auto items across a scope in one API call. The per-document route (section
9.7, `POST /api/documents/:id/sort`) handles "all items, one document". But
"all items, many documents" requires N calls to the per-document route from
the client, one per document. If the scope is large, this is impractical.

Suggestion: make `targetType` and `targetId` optional on `POST /api/sort/run`.
When absent, each enqueued job evaluates all auto items for its document (same
as the per-document route but across a scope). Alternatively, accept this
limitation for v1 and document it.


## Rulings

Per the autonomy rule, I am settling these and recording them here.

1. **Document deletion cascade.** Use ON DELETE CASCADE foreign keys in the C2
   and C3 migrations for `document_tags.document_id` and
   `sort_evaluations.document_id`. Reason: application-level cascade is fragile
   and easy to forget; the DB enforces it permanently.

2. **Tag ordering.** Tags are ordered alphabetically by name (case-insensitive)
   in API responses and the UI. Reason: simplest default, no extra column, and
   the user can rename to control order.

3. **Category/tag name uniqueness.** Enforce with a UNIQUE index using
   COLLATE NOCASE in the migration. For categories:
   `UNIQUE(user_id, parent_id, name COLLATE NOCASE)`. For tags:
   `UNIQUE(user_id, name COLLATE NOCASE)`. Reason: the DB is the only safe
   enforcement point for concurrency (even though single-user, good habit).

4. **Provider slot selection in the UI.** Each slot combobox has a provider
   dropdown beside it. Selecting a provider loads that provider's model list
   into the combobox. The saved value is `provider://model`. Reason: the model
   URI already encodes the provider, so the dropdown is a filter, not separate
   state.

5. **`GET /api/ai/providers` response shape.** Top-level: `{ providers: [...],
   slots: { rules: { value, source, suggestion }, chat: {...},
   embedding: {...} } }`. Slots are not repeated per provider. Reason: slots
   are global state, not per-provider.

6. **`sort_evaluations.job_id`.** Make it NOT NULL. Dry runs are not stored, so
   every stored row has a job. Reason: column reflects reality and simplifies
   queries.

7. **Category path computation.** Load all user categories in one query, build
   paths in application code (a single `Map<id, Category>` and parent-chain
   walk). No recursive CTE. Reason: category count per user is small (hundreds
   at most), and this stays within the "no raw SQL" convention.

8. **Extraction failure sets `rule_status` to `failed`.** When the extraction
   handler catches a final-attempt failure, set `rule_status = 'failed'` and
   `rule_error = 'Extraction failed'` in the same update. Reason: keeps the
   status columns honest and prevents orphaned Inbox entries.

9. **Prompt size.** Log a warning when the assembled prompt exceeds 50000
   characters. Do not hard-fail. Reason: the model will reject it if it is too
   large, and the error surfaces through the job. A warning helps debugging
   without limiting the user arbitrarily. Document this as a known limitation.

10. **`POST /api/sort/run` without a target.** Keep `targetType` and `targetId`
    required for v1. "All items across a scope" is deferred. The per-document
    route plus the scope count endpoint cover the needed workflows. Reason:
    YAGNI; the Sorting page's Run button already picks a specific item.

11. **Dismissed-proposal sameness.** Use `document.content_hash` plus
    `item.updated_at` instead of `document.updated_at`. A rename should not
    re-offer a dismissed proposal. Reason: cheap to implement and reduces noise.

12. **Provider error sanitization.** Strip substrings matching
    `/\b(sk-|or-v1-|ant-)[a-zA-Z0-9_-]{10,}\b/` from error text before
    wrapping in AppError. Reason: defense in depth against key leakage in logs
    and API responses.


## Edge cases the plan must address

1. **Category deleted while a rerun job is queued.** The handler must check that
   the target still exists before building the prompt. If it does not exist, mark
   the job done (not failed) and log a warning.

2. **Provider key removed while a rules job runs.** The job fails with
   `ai.provider_not_configured` or `ai.slot_not_configured`. Standard retry and
   failure path applies. No special handling needed.

3. **Tag or category with same name at different tree levels.** The prompt must
   use full category paths (e.g., "Finance / Tax / Receipts"), not just names,
   to disambiguate. Tags are flat and unique per user, so no ambiguity.

4. **Very large number of auto items.** See M4 above. Log a warning.

5. **Document with no extracted text reaches sorting.** Extraction sets
   `extracted_text` to an empty string for files with no text layer. The
   sorting handler should treat empty text as a valid input and let the model
   classify (likely no matches). It should not skip or fail.

6. **Duplicate upload (same hash) and sorting.** Duplicate detection returns
   the existing document, no new upload or sorting job is created. No issue.

7. **Concurrent rerun jobs for the same document.** If two rerun jobs are
   enqueued (e.g., two different targets via `POST /api/sort/run`), they run
   sequentially (runner concurrency is sequential per the single-connection
   comment). Each writes its own evaluations. No conflict because evaluations
   are append-only and proposals are per (document, target) pair.

8. **Turning off `auto_apply` on a category clears auto-assigned documents.**
   Section 9.6 says "A category set with source `auto` is cleared when its
   item's automatic switch is turned off." The implementation must update all
   documents with `category_id = <this category> AND category_source = 'auto'`
   to set `category_id = null, category_source = null`. This is a batch
   update; the plan should account for it.


## Plan shape assessment

The C1/C2/C3 split is correct. Dependencies are linear: C2 needs the settings
page shell from C1; C3 needs tags, categories, and the AI service from C1+C2.

Database changes requiring user approval before the migration is applied:
- **C2**: one migration creating `categories`, `tags`, `document_tags` tables
  and adding `category_id`, `category_source` columns to `documents`.
- **C3**: one migration creating the `sort_evaluations` table.

The `buildStorageKey` signature change belongs in C2 (alongside the document
column migration) since it affects new uploads immediately.

No change in C1 requires a migration (AI settings are rows in the existing
settings table).


## Verdict

**Ready after fixing:**

1. Add cascade-delete handling for document deletion (B1).
2. Set `rule_status` to `failed` when extraction fails (B2).
3. Add the four missing departures to section 4 (M1, M2).
4. State `category_source = 'auto'` explicitly in section 9.3 (M3).
5. Acknowledge prompt-size limitation (M4, or adopt ruling 9).
6. Pick a sameness definition that ignores metadata-only changes (M5, or adopt
   ruling 11).

None of these require redesign. Each is a sentence or two added to the spec
and at most a few lines of implementation.
