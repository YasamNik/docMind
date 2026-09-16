# Milestone C: Sorting, design

Status: approved in chat on 2026-09-16 (sections 1 to 6), reviewed by `plan-reviewer`
before planning. Parent spec: `2026-09-15-phase-1-smart-sorting-design.md`, Milestone C.
Design doc: `DOCMIND-DESIGN.md`. Where this spec departs from the design doc, the
"Departures" section says so and the design doc is updated in the last plan.

## 1. Purpose and outcome

After Milestone B every document becomes text. Milestone C makes DocMind sort it:
every upload lands in an inbox, is read, and is filed under one category with any
number of tags, or is parked in Needs review when the sorter is not confident. The user
describes categories and tags in plain language; those descriptions are the rules.

Outcome: the smart sorting loop, usable end to end with OpenRouter.

## 2. Scope and delivery order

One spec, three plans, each merged into `main` when its final review is clean.

- **C1, AI providers and settings.** The `ai` module (provider registry, two adapters,
  service with task slots, test connection, model listing) and the settings page with
  the AI tab and a plain Storage tab.
- **C2, tags and categories.** The `tags` module (tags, nested categories, document
  links), library filters, Inbox and Needs review views, sidebar tree, pickers on the
  document page, and the storage key layout change.
- **C3, sorting engine.** The `rules` module: evaluation job, initial and rerun modes,
  proposals and the review flow, run on scope, dry run, cleanup of automatic tags, and
  the Sorting page.

Out of scope for C: embeddings and the destructive embedding model change (Phase 2),
free tag suggestions by the model (later), physical folder sync to external drives
(later), file encryption (later, see section 12), Docker and the first-run wizard (D).

## 3. Decisions made in the brainstorm

1. **One category per document, many tags.** Categories nest. Tags carry overlaps such
   as "rent" and "expenses".
2. **Folders are logical.** The category lives in the database. Files never move after
   upload. The UI shows a tree; export can mirror it later.
3. **Inbox and Needs review are views, not categories.** Inbox: sorting has not run yet.
   Needs review: sorting ran and left no category, or proposals are waiting.
4. **Descriptions are the rules.** Every tag and category has an optional plain-language
   description, a confidence threshold (default 0.7), and an automatic switch. An item
   with a non-empty description and the switch on is evaluated by the sorter. An item
   without a description is manual only. There is no separate rules table.
5. **First pass on upload applies directly.** Confident matches set tags and the
   category. Reruns never change anything silently: they produce proposals the user
   accepts or dismisses per line.
6. **New descriptions apply to new documents only.** Existing documents change only
   through a rerun: per document, or per item over a scope (Needs review, one category,
   all), with the document count shown before confirming.
7. **The sorter stays inside the user's vocabulary.** It never invents tags.
8. **Manual assignments are never touched by the engine.** Manual and automatic sources
   are tracked separately on tags; the category records its source.
9. **One or a few flat buckets, structure in the database.** The existing
   `storage_driver` column identifies the bucket. Storage keys gain a year and month
   prefix so no folder grows without bound.
10. **One LLM call per document with every automatic item in the prompt** (chosen over
    a two-call design and a two-section design, see section 8).

## 4. Departures from the design doc

- `rules` and `rule_evaluations` tables are replaced by description, threshold, and
  automatic fields on `tags` and `categories`, plus a `sort_evaluations` table keyed by
  target type and id. The `rules/` module stays and becomes the sorting engine.
- `document_categories` is dropped; `documents` gains `category_id` and
  `category_source` because a document has at most one category.
- Storage keys change from `user/document/filename` to
  `user/YYYY/MM/document/filename` for new uploads.

## 5. Data model

All ids are the project's text ids, timestamps ISO 8601 UTC strings, booleans as
integers 0 or 1.

```
categories
  id TEXT PRIMARY KEY
  user_id TEXT NOT NULL
  name TEXT NOT NULL                    -- unique among siblings, case-insensitive
  parent_id TEXT                        -- null at the root; no cycles
  color TEXT                            -- hex, optional
  description TEXT NOT NULL DEFAULT ''  -- up to 2000 characters
  confidence_threshold REAL NOT NULL DEFAULT 0.7
  auto_apply INTEGER NOT NULL DEFAULT 1
  sort_order INTEGER NOT NULL DEFAULT 0
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

tags
  id TEXT PRIMARY KEY
  user_id TEXT NOT NULL
  name TEXT NOT NULL                    -- unique per user, case-insensitive
  color TEXT
  description TEXT NOT NULL DEFAULT ''  -- up to 300 characters
  confidence_threshold REAL NOT NULL DEFAULT 0.7
  auto_apply INTEGER NOT NULL DEFAULT 1
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

documents (added columns)
  category_id TEXT                      -- null: no category
  category_source TEXT                  -- 'manual' | 'auto' | null

document_tags
  document_id TEXT NOT NULL
  tag_id TEXT NOT NULL
  applied_by_manual INTEGER NOT NULL DEFAULT 0
  applied_by_auto INTEGER NOT NULL DEFAULT 0
  PRIMARY KEY (document_id, tag_id)     -- row deleted when both flags are 0

sort_evaluations
  id TEXT PRIMARY KEY
  document_id TEXT NOT NULL
  target_type TEXT NOT NULL             -- 'tag' | 'category'
  target_id TEXT NOT NULL
  matched INTEGER NOT NULL
  confidence REAL NOT NULL              -- 0.0 to 1.0
  reasoning TEXT NOT NULL               -- one sentence from the model
  outcome TEXT NOT NULL                 -- 'applied' | 'proposed' | 'dismissed' | 'below_threshold' | 'no_match'
  proposal_kind TEXT                    -- 'add_tag' | 'remove_tag' | 'set_category' | null
  model_id TEXT NOT NULL                -- provider://model
  job_id TEXT                           -- the sort job, null for dry runs (dry runs are not stored)
  evaluated_at TEXT NOT NULL
```

Indexes: `categories(user_id, parent_id)`, `tags(user_id)`, `document_tags(tag_id)`,
`documents(user_id, category_id)`, `sort_evaluations(document_id, evaluated_at)`,
`sort_evaluations(target_type, target_id)`, `sort_evaluations(outcome)`.

Rules:

- Deleting a category moves its children to its parent (or the root) and clears
  `category_id` and `category_source` on its documents. Its evaluations are deleted.
- Deleting a tag deletes its links and evaluations.
- Changing a description, threshold, or the automatic switch does not touch existing
  documents or evaluations.
- "Rules not yet run" means `rule_status` is `pending` or `processing`. Needs review
  means `rule_status` is `done` and either `category_id` is null or at least one
  evaluation for the document has outcome `proposed`.

## 6. Storage key layout

`buildStorageKey` produces `${userId}/${yyyy}/${mm}/${documentId}/${safeName}` using the
upload time in UTC. Existing keys stay as they are; nothing is migrated. The local driver
already validates keys against traversal; no driver change is needed. The
`storage_driver` column is the bucket id; a second bucket is a later feature.

## 7. AI module (plan C1)

Directory `apps/server/src/modules/ai/`.

### 7.1 Provider registry, `providers/`

One definition per provider, in this display order: `openrouter`, `openai`, `anthropic`,
`ollama`, `mistral`, `deepseek`, `lmstudio`, `custom`. A definition holds:

- `id`, `label`, `adapter` (`openai-compatible` | `anthropic`), `defaultBaseUrl`,
  `requiresKey`.
- `capabilities`: `text`, `structured`, `embeddings`, `listModels`, each boolean.
- `suggestedModels`: `{ rules, chat, embedding? }` model ids to suggest when a slot is
  empty (for OpenRouter: a current fast structured-output model for rules, a flagship
  for chat).
- `guide`: `{ title, intro, steps: [{ text, link?, copyValue? }], notes: string[] }`.
- `settings`: emitted into the settings registry the way storage drivers do:
  `ai.<id>.apiKey` (secret, env `<ID>_API_KEY`, for example `OPENROUTER_API_KEY`) and
  `ai.<id>.baseUrl` (default `defaultBaseUrl`, env `<ID>_BASE_URL`). Ollama and LM
  Studio do not require a key. Custom requires a base URL.

Slot settings, defined once in `ai.settings.ts`: `ai.model.rules`, `ai.model.chat`,
`ai.model.embedding`, each a `provider://model` string or empty. Env fallbacks
`AI_MODEL_RULES`, `AI_MODEL_CHAT`, `AI_MODEL_EMBEDDING`. On a fresh install with an
OpenRouter key present and no slot set, the service uses OpenRouter's suggested models,
and the UI shows them as placeholders.

### 7.2 Adapters, `adapters/`

Common interface `AiAdapter`:

```
generateStructured({ model, system, input, schema, schemaName }) -> { data: unknown, usage }
streamText({ model, system, input }) -> AsyncIterable<string>
embed({ model, texts }) -> { vectors: number[][], dimension }
listModels() -> { id, label, contextLength?, pricing?, supportsStructured? }[]
testConnection() -> { ok, latencyMs, message }
```

- **OpenAI-compatible** on the official `openai` package with `baseURL` and `apiKey`.
  Structured calls use chat completions with `response_format: { type: "json_schema" }`
  and the valibot schema converted to JSON schema. For OpenRouter: headers
  `HTTP-Referer` and `X-Title` for attribution, `require_parameters: true` on
  structured calls, and `listModels` reads `supported_parameters` to set
  `supportsStructured`; the embedding slot uses OpenRouter's embeddings model list.
  Covers every provider except Anthropic.
- **Anthropic** on the official `@anthropic-ai/sdk`. Structured output through the
  SDK's structured parse helper with the same JSON schema; streaming for text; models
  endpoint for listing; `embed` throws `ai.unsupported`.
- Every adapter returns provider error text verbatim inside an `AppError` with code
  `ai.provider_error`, never the key.

### 7.3 Service, `ai.usecases.ts`

`createAiService({ settingsService, registry, adapters })`:

- `generateStructured({ userId, task, schema, system, input })` where `task` is `rules`
  or `chat`. Resolves `ai.model.<task>` (or the suggested model), splits
  `provider://model`, checks credentials and capability, builds the adapter, calls it,
  validates the reply with the valibot schema, returns typed data. Errors:
  `ai.slot_not_configured`, `ai.provider_not_configured`, `ai.capability_missing`,
  `ai.invalid_response` (schema failure, includes the first issue path),
  `ai.provider_error`.
- `streamText` and `embed` with the same resolution.
- `listModels(userId, providerId)` cached in memory per provider and base URL for ten
  minutes; on failure returns `{ models: [], error }` so the UI falls back to free text.
- `testConnection(userId, providerId)`: lists models where supported, else a one-token
  completion; returns latency and the provider's message.
- Logs task, model, latency, and token usage at info level; never the prompt or key.

### 7.4 Routes, `ai.routes.ts`

- `GET /api/ai/providers`: registry entries with guide, `keySet`, `keyLastFour`,
  `baseUrl` with its source, and the three slot values with sources and suggestions.
- `POST /api/ai/providers/:id/test`: `{ ok, latencyMs, message }`.
- `GET /api/ai/providers/:id/models`: `{ models, error? }`.
- Slot and key writes go through the existing `PUT /api/settings`. Writing a slot
  validates credentials and capability through the service and answers 400 with a
  clear code when they are missing.

### 7.5 Settings page, client

Sidebar entry "Settings", route `/settings`, tabs AI and Storage.

- **AI tab.** One card per provider in registry order, OpenRouter expanded first.
  Card: key field showing "Set, ends in ····abcd" when set with a Replace and a Clear
  action, base URL field with a "from environment" badge when applicable, Test button
  with the result inline (latency or the provider's message), and the guide beside the
  form (title, intro, numbered steps with links and copy buttons, notes). Below the
  cards, three comboboxes for the slots, each fed by the models route of the chosen
  provider, free text allowed, suggested model shown as placeholder, save per slot.
- **Storage tab.** A form generated from the storage settings (active driver, local
  root), with save. Small, included because the page shell exists now.

### 7.6 Tests

Adapters against recorded HTTP responses committed under `ai/__fixtures__/` (models
list, one structured completion, one error), never the network. Service with a fake
adapter. Routes on the in-memory database with the fake adapter. Client tests for the
provider card states and the slot combobox fallback. Manual check with the user's real
OpenRouter key closes C1.

## 8. Tags and categories (plan C2)

Directory `apps/server/src/modules/tags/` holds tags and categories.

### 8.1 Routes

- `GET /api/tags`, `POST /api/tags`, `PATCH /api/tags/:id`, `DELETE /api/tags/:id`.
  Body fields: `name`, `color`, `description`, `confidenceThreshold`, `autoApply`. List
  responses include `documentCount`.
- `GET /api/categories` (flat list with `parentId`, `path`, `documentCount`,
  `sortOrder`), `POST`, `PATCH /:id` (including `parentId` moves; rejects cycles and
  self-parenting with `categories.invalid_parent`), `DELETE /:id` (children move up,
  documents cleared).
- `PUT /api/documents/:id/category` with `{ categoryId | null }`: sets the category by
  hand, `category_source = 'manual'`, or clears it.
- `POST /api/documents/:id/tags/:tagId` and `DELETE /api/documents/:id/tags/:tagId`:
  set or clear the manual flag; the row is deleted when both flags are 0.
- `GET /api/documents` gains `categoryId` (includes descendants), `tagId`, and `view`
  (`inbox` | `needs_review` | `all`, default `all`). List rows gain `categoryId`,
  `categoryPath`, and `tags: [{ id, name, color, auto, manual }]`.

Validation: names 1 to 60 characters, descriptions within the limits in section 5,
threshold between 0 and 1, colors as `#rrggbb`.

### 8.2 Client

- Sidebar: Inbox and Needs review entries with count badges above a category tree with
  counts, then a tag list with counts. Selecting filters the library; category and tag
  filters combine.
- Manage screens at `/tags` and `/categories`: create, edit, delete, reorder and
  reparent categories, with the description, threshold, and automatic fields. A
  "Test on a document" button is the dry run and is wired in C3.
- Document page: category picker over the tree, tag picker with chips; an automatic
  mark on chips and on the category when set by the sorter. Library rows show the
  category path and tag chips.

## 9. Sorting engine (plan C3)

Directory `apps/server/src/modules/rules/`.

### 9.1 Job

Job type `rules`, payload `{ documentId, userId, mode, targetType?, targetId? }`, mode
`initial` or `rerun`. The extraction handler enqueues an `initial` job in the same
transaction that marks extraction `done`, only when at least one automatic item exists;
otherwise `rule_status` is set to `done` directly. `rule_status` mirrors the job the
same way `extraction_status` does.

### 9.2 Prompt and reply

One call per document through the `rules` task slot. The system prompt explains the
task: given a document's text and the user's categories and tags, decide for each item
whether the document belongs to it. Input: the category tree as paths with
descriptions, the tag list with descriptions, only items with `auto_apply = 1` and a
non-empty description (or the single item under rerun-on-scope), and the document text
truncated to 8000 characters with a note that it is truncated. Reply schema, validated
with valibot:

```
{ items: [{ type: 'tag' | 'category', id: string, matched: boolean, confidence: number (0..1), reasoning: string (1..300 chars) }] }
```

Items missing from the reply count as `no_match` with confidence 0. Unknown ids are
dropped and logged.

### 9.3 Initial mode

- Every tag with `matched` and `confidence >= threshold` gets `applied_by_auto = 1`.
- The category is the matched category with the highest confidence at or above its
  threshold. On a tie, no category is set. Manual category is never replaced.
- Evaluations are stored with outcome `applied`, `below_threshold`, or `no_match`.

### 9.4 Rerun mode

- Nothing is applied. Each result becomes an evaluation with outcome `proposed` and a
  `proposal_kind`: `add_tag` for a matched tag not yet on the document, `remove_tag` for
  an automatic tag on the document whose item no longer matches, `set_category` for a
  matched category different from the current one when the current one is not manual
  or is null. Results that would change nothing are stored as `applied` (already
  true) or `no_match`.
- A proposal equal to one dismissed earlier for the same document, item, kind, and
  unchanged description and document text is stored as `dismissed` again, not offered.
  Sameness is decided by comparing the item's `updated_at` and the document's
  `updated_at` to the dismissed evaluation's `evaluated_at`.

### 9.5 Proposals API and review

- `GET /api/documents/:id/proposals` and `GET /api/proposals?limit&cursor`: proposed
  evaluations with document name, item name, kind, confidence, reasoning.
- `POST /api/proposals/apply` with `{ accept: ids[], dismiss: ids[] }`: accepted
  `add_tag` sets the automatic flag, `remove_tag` clears it (row deleted when both
  flags are 0), `set_category` sets the category with source `auto`. Accepted rows get
  outcome `applied`, dismissed rows `dismissed`. All in one transaction.

### 9.6 Cleanup of automatic tags

The automatic flag on a link is cleared when a `remove_tag` proposal is accepted, when
the tag is deleted, or when the tag's automatic switch is turned off. Manual flags are
never touched. A category set with source `auto` is cleared when its item's automatic
switch is turned off; a manual one stays.

### 9.7 Run on scope and per document

- `POST /api/sort/run` with `{ targetType, targetId, scope }` where scope is
  `needs_review`, `category:<id>`, or `all`. Returns `{ count, jobIds }` and enqueues one
  `rerun` job per document carrying the target. `GET /api/sort/count?scope=` returns the
  count for the confirm dialog.
- `POST /api/documents/:id/sort` enqueues one `rerun` job for all automatic items and
  returns the job.

### 9.8 Dry run

`POST /api/sort/dry-run` with `{ documentId, targetType, name, description, threshold }`
runs the single item against the document synchronously and returns
`{ matched, confidence, reasoning, wouldApply }`. Nothing is stored. It works on unsaved
descriptions.

### 9.9 Client

- "Sorting" page at `/sorting`: the list of automatic items with descriptions and a
  Run button opening the scope dialog with the count; the Proposed changes list with
  per-line checkboxes, accept selected, accept all, dismiss selected.
- Document page: "Run rules" action; when a rerun finishes, a review dialog with the
  document's proposals (category current versus proposed, tags to add, tags to remove),
  each with reasoning and a checkbox; polling reuses the existing job polling.
- Tag and category editors: the "Test on a document" panel, a document picker and the
  dry-run result.

## 10. Testing

- `*.models.ts` unit tested: key layout, tree path building, cycle detection, prompt
  assembly, reply validation, category tie-break, proposal derivation, dismissed
  sameness.
- Usecases and routes on in-memory SQLite with a fake AI adapter returning scripted
  replies, through the real job runner.
- Adapters on recorded responses only.
- Client: tree, pickers, review dialog, provider cards, slot comboboxes.
- Manual acceptance after C3: upload a rent invoice, see it filed under the right
  category with rent and expenses tags; run a category over Needs review; accept one
  proposal and dismiss another; the dismissed one is not offered again.

## 11. Migrations

One migration per plan: C1 none (settings are rows); C2 creates `categories`, `tags`,
`document_tags`, adds the two document columns; C3 creates `sort_evaluations`. Existing
databases keep working after each.

## 12. Encryption, noted for later

Files in storage can be encrypted per object later with a key in settings, since keys
are opaque and structure lives in the database. Field-level encryption of names and
extracted text inside the database would defeat search and vector indexes, so the plan
for the database is encryption at rest through the deployment (encrypted volume or
database file). Nothing in C blocks either.

## 13. Resolved by plan-reviewer, not the user

Per the autonomy rule in `CLAUDE.md`, remaining implementation questions (exact
prompt wording, id and error code names, cache details, pagination sizes, exact UI
component choices) are settled during plan review and recorded in the plan.
