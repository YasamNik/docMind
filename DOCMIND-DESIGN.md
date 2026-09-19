# DocMind: Design and Agent Instructions

A private assistant and secretary whose memory is your document library. It reads
everything you give it, files it by plain English rules, finds it again by keyword or
meaning, answers questions about it, and, in later phases, watches dates and money and
acts on your calendar and mail with your approval.

This file is the spec. `CLAUDE.md` says how we work. `docs/FEATURES.md` holds the full
feature list and the delivery phases. Read all three before writing code.

## Vision

Documents are the memory. Every other capability is a module over that memory: notes,
collections, tasks and reminders, calendar, correspondence, contacts, the knowledge
wiki, investments. Modules share one settings system, one AI provider layer, one storage
layer, one job runner, and one bot. None of them bends the document core.

Phase 1 is smart sorting: upload any document, extract its text, apply user-written
rules to tag and categorize it, and see why. Everything else builds on that loop.

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Server | Hono (Node) | Lightweight, fast, runs anywhere |
| Client | React + Vite | Wide ecosystem, good component libraries |
| Database | SQLite via libsql + Drizzle ORM | Free, no server needed, single-file deploy |
| Vector search | sqlite-vec extension | Embeddings in SQLite, no separate service |
| Auth | better-auth | Lightweight, works with Hono |
| AI providers | Own thin adapter layer over the official OpenAI and Anthropic SDKs | Every provider is either OpenAI-compatible or Anthropic. No framework in between |
| Styling | Tailwind CSS | Utility-first, fast iteration |
| Validation | valibot | Every boundary: HTTP, env, settings, LLM output |
| Deploy target | Any $5 VPS, Fly.io, or local | No paid services required |

## Architecture Overview

```
Browser (React SPA)
  |
  |--- /api/*  ------>  Hono Server (:4000)
                          |
                          |--- Settings module (DB-backed, env-seeded, encrypted secrets)
                          |--- SQLite (documents, rules, users, chat, settings)
                          |--- sqlite-vec (document embeddings)
                          |--- AI provider layer (OpenRouter first, Anthropic, OpenAI, Ollama, custom)
                          |--- Storage driver layer (local, S3, Google Drive, OneDrive)
                          |--- Content extraction (MIME dispatch, OCR)
                          |--- Job runner (extraction, rules, embeddings)
```

Single process. No microservices, no message queues, no Redis. Background tasks run
in-process through a simple job queue with explicit status transitions.

## Data Model

```sql
-- Core
users (id, email, name, created_at)
-- better-auth manages session and account tables

-- Settings (see Settings Module)
settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,             -- JSON; ciphertext for secret keys
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
)

-- Documents
documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  content_hash TEXT,               -- sha256, for duplicate detection
  storage_driver TEXT NOT NULL,    -- which driver holds the file
  storage_key TEXT NOT NULL,       -- driver-specific key or id
  extracted_text TEXT,
  extraction_status TEXT DEFAULT 'pending',  -- pending | processing | done | failed
  extraction_error TEXT,
  rule_status TEXT DEFAULT 'pending',        -- pending | processing | done | failed
  rule_error TEXT,
  embedding_status TEXT DEFAULT 'pending',   -- pending | processing | done | failed
  embedding_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

-- Categorization
categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- unique among siblings, case-insensitive
  parent_id TEXT,                        -- null at the root; no cycles
  color TEXT,
  description TEXT NOT NULL DEFAULT '',  -- up to 2000 characters; the plain-language rule
  confidence_threshold REAL NOT NULL DEFAULT 0.7,
  auto_apply INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- unique per user, case-insensitive
  color TEXT,
  description TEXT NOT NULL DEFAULT '',  -- up to 300 characters; the plain-language rule
  confidence_threshold REAL NOT NULL DEFAULT 0.7,
  auto_apply INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
document_tags (
  document_id TEXT NOT NULL,             -- ON DELETE CASCADE to documents
  tag_id TEXT NOT NULL,                  -- ON DELETE CASCADE to tags
  applied_by_manual INTEGER NOT NULL DEFAULT 0,
  applied_by_auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, tag_id)
)
-- documents also carries category_id (nullable) and category_source ('manual' | 'auto' |
-- null): a document has at most one category, so there is no document_categories table.
-- One document_tags row per pair. A rule and a manual action can both apply the same
-- tag; each source is tracked and removed independently. The row goes away when both
-- flags are 0. There is no separate rules table: a non-empty description plus
-- auto_apply on a tag or category is the rule. The sorting engine (Milestone C,
-- plan C3) adds a sort_evaluations table and the cleanup logic for applied_by_auto.

-- Rules Engine
-- No separate rules table: a non-empty description plus auto_apply on a tag or
-- category (see the Categorization block above) is the rule.
sort_evaluations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,            -- ON DELETE CASCADE to documents
  target_type TEXT NOT NULL,            -- 'tag' | 'category'
  target_id TEXT NOT NULL,              -- references tags(id) or categories(id) by type;
                                         -- no foreign key, a polymorphic reference is
                                         -- handled in application code instead
  matched INTEGER NOT NULL,
  confidence REAL NOT NULL,             -- 0.0 to 1.0
  reasoning TEXT NOT NULL,              -- one sentence from the model
  outcome TEXT NOT NULL,                -- applied | proposed | dismissed | below_threshold | no_match
  proposal_kind TEXT,                   -- add_tag | remove_tag | set_category | null
  model_id TEXT NOT NULL,               -- provider://model that produced it
  job_id TEXT NOT NULL,                 -- the rules job that produced it; dry runs are not stored
  content_hash TEXT,                    -- the document's hash at evaluation time, used to
                                         -- decide whether a dismissed proposal is offered again
  evaluated_at TEXT NOT NULL
)

-- Jobs (every background operation, in every phase)
jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- extraction | rules | embedding | later: move_storage, reembed_all, wiki_ingest, email_poll ...
  status TEXT NOT NULL,            -- pending | processing | done | failed
  payload TEXT NOT NULL,           -- JSON, e.g. {documentId}
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,      -- not claimed before this time; backoff between attempts
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
)
-- The status columns on documents are a cache of the latest job of each type for
-- that document, so the library can filter cheaply. Creating a job sets the matching
-- document status to pending in the same transaction; every later transition updates
-- it the same way. The jobs table is the source of truth and what the jobs view lists.
-- Re-evaluating a rule creates one rules job per affected document, so progress is
-- visible and a crash loses at most one document's work.
-- While a job is retrying, the document's status column stays `pending` with the last
-- error in its error column; it becomes `failed` only when the job has no attempts left.

-- Vector Search
document_chunks (id, document_id, chunk_index, chunk_text, token_count)
-- sqlite-vec virtual table for embeddings, linked by chunk id. Its dimension is
-- recorded in the system settings ai.embedding.activeModel and ai.embedding.dimensions.

-- Chat
chat_sessions (id, user_id, title, created_at)
chat_messages (id, session_id, role, content, sources, created_at)
-- sources: JSON array of {chunk_id, document_id, relevance}
```

Timestamps are ISO 8601 strings in UTC. Every status has a `failed` state and an error
column. On startup the runner resets every job still in `processing` to `pending` and
retries it, so a crash mid-job never leaves a row stuck. A job that fails more than
three times stays `failed` until retried by hand from the jobs view. Manual retry
resets the attempt count to zero.

## Settings Module

One module owns every user-editable configuration value, resolves the effective value
for other modules, and keeps secrets encrypted. No other module reads env vars for AI
or storage.

**Registry.** Each module declares its settings the way modules declare config: key,
valibot schema, optional env var fallback, default, and a secret flag. The settings
module composes them into one registry. Examples:

```
ai.models.rules               modelId   env AI_RULES_MODEL
ai.models.chat                modelId   env AI_CHAT_MODEL
ai.models.embedding           modelId   env AI_EMBEDDING_MODEL
ai.providers.openrouter.apiKey  secret  env OPENROUTER_API_KEY
storage.activeDriver          driverId  env STORAGE_DRIVER    default local
storage.local.root            string    env DOCUMENT_STORAGE_ROOT  default ./documents
storage.s3.bucket             string    env S3_BUCKET
storage.s3.secretAccessKey    secret    env S3_SECRET_ACCESS_KEY
```

**Resolution order.** Database value, then env var, then default. The database wins so
the UI can always change a value. Every resolved value carries its source so the UI can
show a "from environment" badge.

**Storage.** The `settings` table, keyed by user and key. Secret keys hold ciphertext.
Scoping by user costs one column now and makes multi-user later trivial.

**Encryption.** AES-256-GCM with a key from the required env var
`SETTINGS_ENCRYPTION_KEY`, generated with `openssl rand -hex 32`. The server refuses to
start without it and prints that command. Server code reads plaintext only through the
settings service. The API never returns a secret, only whether one is set and its last
four characters. Sending `null` for any key deletes the database row, so the value
falls back to the env var or default. For secret keys an empty string does the same;
empty ciphertext is never stored. Key rotation is out of scope.

Every provider definition is built in Phase 1 because they share one adapter, but only
the OpenRouter path is exercised end to end in Phase 1. Other providers are verified
when first used.

**API.** Read all settings with values, sources, and masked secrets. Batch update
validated per key. Test a provider or driver connection. List models for a provider.

**Client.** One settings page with an AI tab and a Storage tab. Forms are generated
from the registry, so adding a provider or driver needs no bespoke form code.

**Setup guides.** Every provider and driver definition carries a structured guide: a
title, a one-line intro, numbered steps, and notes. Each step has text, an optional
link to the exact page, and an optional copyable value such as a redirect URI or an IAM
policy. The UI renders the guide beside the form. Guides are a hard requirement, not
polish: the user must be told exactly where to go and what to paste.

**Caching.** Resolved values are cached in memory and invalidated on write. Adapters
are rebuilt when their inputs change.

## AI Provider Layer

**Provider registry.** Each provider is one definition: id, label, adapter kind, default
base URL, whether a key is required, capability flags for text, embeddings, and model
listing, and its setup guide. Built-in providers, in display order: OpenRouter, OpenAI,
Anthropic, Ollama, Mistral, DeepSeek, LM Studio, and Custom (any OpenAI-compatible base
URL). Adding a provider means adding one definition. The registry also emits the
provider's settings definitions, so its key and base URL fields appear in the UI.

**OpenRouter is the main option.** Listed first, preselected on first run, and the
quick-start path assumes it. One key covers all three model slots. The adapter sends
the app attribution headers and passes `require_parameters: true` on structured calls
so OpenRouter routes only to backends that honor the JSON schema. The rules slot
filters OpenRouter's model list to models whose `supported_parameters` include
`structured_outputs`. The chat slot shows context length and price. The embedding slot
uses OpenRouter's separate embeddings model list.

**Two adapter kinds.** OpenAI-compatible uses the official OpenAI SDK with a custom base
URL and covers every provider except Anthropic: chat completions with JSON schema
response format, streaming, the embeddings endpoint, the models endpoint. Anthropic
uses the official Anthropic SDK: the parse helper for structured output, streaming for
chat, the models endpoint for listing. Anthropic has no embeddings endpoint and never
appears in the embedding slot.

**Service interface.** Callers name a task, never a model: generate structured data for
a task, stream text for a task, embed a list of texts. The service resolves the task to
a model URI (`provider://model`) through settings, builds the adapter with the
provider's credentials, and calls it.

**Model slots.** Rules, chat, embedding. Saving a slot validates that the provider has
credentials and supports the capability. Each slot is a combobox fed by the provider's
model list, with free-text fallback. The UI suggests each provider's current flagship
model as a starting point.

**Changing the embedding model** is destructive because the vector table has a fixed
dimension. The UI warns that every document will be re-embedded and asks to confirm.
The server records the new model and dimension, recreates the vector table, resets
every document's embedding status to pending, and the job runner re-embeds.

**Test connection** lists models where supported, otherwise sends a one-token
completion. It returns latency and the provider's error text verbatim.

## Storage Layer

Storage is a blob backend only. DocMind is the source of truth; it never scans or
imports files that already live on a drive.

**Driver interface.** Put a stream and return a storage key, get a stream by key,
delete, exists, health check. Put and get are streams end to end. The driver chooses
the key, because Google Drive and OneDrive address files by id rather than path.

**Driver registry.** Same shape as the provider registry: each driver carries its
settings definitions, an optional OAuth hook, a setup guide, and a factory.

**Drivers.**
- **Local.** Root path, default `./documents`. Keys are
  `userId/yyyy/mm/documentId/filename` using the upload time in UTC, so no folder grows
  without bound, resolved inside the root with traversal rejected. Existing keys are not
  migrated when this format changed in Milestone C. Guide: absolute paths, permissions,
  Docker volumes.
- **S3 compatible.** Bucket, region, optional endpoint, path-style flag, key prefix,
  access key id, secret. Health check is head-bucket. Guide: IAM user with a minimal
  one-bucket policy as a copyable value, endpoint notes for MinIO, Cloudflare R2,
  Backblaze B2.
- **Google Drive.** Client id, client secret, refresh token from OAuth. Scope
  `drive.file` only, so no app verification. Files go in a DocMind folder created on
  connect. Resumable upload above five megabytes. Guide: Cloud project, enable Drive
  API, consent screen, web OAuth client, paste the redirect URI, publish the app so
  refresh tokens do not expire after seven days.
- **OneDrive.** Client id, client secret, refresh token. Microsoft Graph app folder,
  permissions `Files.ReadWrite.AppFolder` and `offline_access`. Upload session above
  four megabytes. Guide: Azure app registration for personal and work accounts,
  redirect URI, client secret copied immediately, secret expiry reminder.
- **Proton Drive** is deferred. Its SDK is pre-1.0, not for third-party production use,
  and a crypto migration in late 2026 will break clients built on it.

**OAuth flow.** Two routes in the storage module, start and callback, parameterized by
driver. Start redirects with a state value signed by a key derived from
`SETTINGS_ENCRYPTION_KEY` with HKDF and the label `oauth-state`, expiring after ten
minutes. Callback exchanges the
code, stores the refresh token as a secret, records the connected account's email, and
redirects to settings. Drivers refresh access tokens themselves. A disconnect action
clears tokens. The form shows the exact redirect URI derived from the server base URL,
with a copy button and a note that scheme, host, and port must match exactly.

**Switching drivers.** Each document row records its driver. The active driver is the
storage you are looking at: the documents list, the trash and their counts show only
documents held there, and reading a file from any other driver is refused with a message
naming that storage and the original's location. Search, chat, export and every background
job stay unscoped, so knowledge is never hidden even when the file is: a chat answer can
cite a document on an inactive storage, say which storage holds it, and point at it.
Each driver answers `describeLocation(key)` without a network call so that pointer works
while the driver is inactive. The UI shows how many documents each driver holds, asks for
confirmation before a switch with those counts in the question, and refuses to clear
credentials for a driver that holds any. A move-documents job is a later item.
(Decided 2026-09-18, replacing "changing the active driver affects new uploads only".)

**Errors** map to a small set: auth expired, not found, quota, network. Auth expired
surfaces on the settings page as a Reconnect prompt.

## Rules Engine

The Phase 1 differentiator. Users write rules in plain English:

- "Tag as 'Medical' if the document mentions prescriptions, medications, or doctors"
- "Categorize as 'Tax/Receipts' if this is a purchase receipt or invoice"
- "Tag as 'Urgent' if the document contains deadlines within 30 days"

**Evaluation flow.**
1. Text is extracted; on the first upload, if at least one tag or category has both a
   description and automatic sorting on, an initial rules job is enqueued.
2. The user's automatic tags and categories are loaded (auto_apply on, description
   non-empty).
3. One prompt is assembled with the document name, the document text, and every
   automatic item, each with its id, description, and full path (for a category) or name
   (for a tag). Text is truncated to 8000 characters with a note that it is truncated.
   Known limitation: an item that matches only on content past that point will miss.
   Later phases can evaluate per chunk.
4. The rules model returns structured JSON validated by valibot: per item, matched,
   confidence, reasoning. Unknown ids in the reply are dropped and logged.
5. On the first pass (initial mode), every tag matched at or above its threshold is
   applied, and the highest-confidence matched category at or above its own threshold is
   set (none on a tie), unless the document already has a manual category. On every later
   pass (rerun mode, per document or per item over a scope), nothing is applied directly:
   each result becomes a reviewable proposal (add a tag, remove a tag, or set a category),
   and a proposal identical to one the user already dismissed for that document, item, and
   kind is not offered again unless the item's description or the document's content
   changed since the dismissal.
6. Every evaluation is stored in `sort_evaluations` with the model that produced it and
   the job that produced it (dry runs are never stored).

**Design decisions.** One LLM call per document, covering every automatic tag and
category at once. Reasoning is stored so users can tune descriptions. A dry run tests a
description against a chosen document before saving, on unsaved text. The confidence
threshold is per tag or category, on a 0.0 to 1.0 scale. Items are referenced by id, so
renaming a tag never breaks anything, and nested categories are unambiguous through full
paths in the prompt. There is no priority between items: every automatic item is
evaluated in one call and every tag match above its threshold applies (a category picks
its single best match). Manual assignments are never touched by the engine. A very large
or verbose set of automatic items costs more per document to sort; the engine logs a
warning past 50,000 prompt characters rather than capping it. Later phases add inbox
triage and rules that learn from corrections; see `docs/FEATURES.md`.

## Search and Chat

**Chunking.** Roughly 500 tokens per chunk with 50 overlap, stored in `document_chunks`,
embedded through the embedding slot, stored in sqlite-vec.

**Query flow.** Embed the question. Vector search for the top 10 chunks. FTS5 keyword
match on the question. Merge with reciprocal rank fusion. Assemble the top 5 chunks as
context. Call the chat model with a system prompt that answers from the context and
cites sources. Stream to the client. Save the message with source references.

The knowledge wiki in a later phase sits above this: chat reads wiki pages first and
falls back to raw chunks, citing both.

## The Assistant

Chat is not a question box. The same brain answers in the app and in Telegram, and it can
act, not only reply. Specs: `docs/superpowers/specs/2026-09-19-telegram-assistant-design.md`
and `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md`.

**Tool calling lives in the AI layer.** `streamChatWithTools` yields a typed stream,
`{ type: "text" }` or `{ type: "toolCall" }`, and each adapter reassembles its own
provider's wire format into that shape: OpenAI-style fragmented deltas that must be
concatenated into valid JSON, Anthropic's discrete `tool_use` blocks. Arguments are parsed
with the tool's valibot schema, a malformed call is retried once with the parse error fed
back, and a second failure is reported as `ai.tool_call_invalid` rather than guessed at.
`supportsTools` is checked before tools are offered, because a model that silently ignores
them would make the assistant look like it worked while saving nothing.

**Triage is tool choice, not a classify pass.** One model call picks the tool and writes
the answer. A clarifying question is a tool (`askUser`), not a branch in our code. Slash
commands bypass triage: someone who types `/note` means it.

**Capabilities are records, not a switch.** Each tool is a registry entry: name, the
description the model reads, a valibot schema, `writes`, `destructive`, and a handler.
Reminders and calendar arrive as records, and the router does not change.

**Every write proposes and waits.** The pending proposal lives in
`chat_sessions.pending_tool_call` until it is answered, so the app (a stream event and a
pair of buttons) and Telegram (an inline keyboard, which means the poll loop handles
`callback_query`) share one mechanism. Deleting is always confirmed, and no instruction can
loosen that: the guard is the `destructive` flag on the record, not a sentence in a prompt.

**The user's standing instructions** are one markdown document in `chat.instructions`,
appended to the system prompt each turn, versioned into `chat.instructionsHistory` (twenty
versions), and refused above 8000 characters. The cap is enforced in code, because an
unbounded document is unbounded cost on every message. Precedence is stated in the prompt:
the user's instructions beat the defaults, and the code guards beat both.

## Delivery Phases

Every phase ends with something the user runs daily. The full map with item numbers is
in `docs/FEATURES.md`. Each phase gets its own brainstorm, spec, and plan when reached.

1. **Smart sorting.** Sign in, upload, extraction, library with preview, tags and
   categories, rules engine with dry run, settings with OpenRouter and local storage,
   jobs view, Docker.
2. **Find and ask.** Search, embeddings, chat with citations, auto summary and title,
   inbox triage.
3. **Intake from anywhere.** Telegram bot, email intake, notes and voice notes, S3,
   Google Drive, OneDrive.
4. **Secretary basics.** Reminders, tasks, calendar, renewals and expiries, morning
   brief, rules learning from corrections.
5. **Collections.** Software tools table, read-it-later, smart fields, bulk actions,
   trash, saved searches, export.
6. **Knowledge wiki.**
7. **Investments.**
8. **Secretary, full.**

## Project Structure

```
docmind/
  ref_code/                    -- papra reference source, untracked, reference only
  apps/
    server/
      src/
        index.ts
        modules/
          config/              -- env config (figue and valibot pattern)
          settings/            -- registry, resolution, encryption, routes
          auth/
          database/            -- drizzle, libsql, migrations
          documents/           -- upload, CRUD, storage keys
          storage/             -- driver interface, registry, drivers/, oauth routes, guides
          extraction/          -- MIME dispatch, OCR, extraction job
          rules/               -- rules CRUD, evaluation job, dry run
          search/              -- FTS5 and vector hybrid search
          chat/                -- RAG chat
          ai/                  -- service, providers/ registry, two adapters, guides
          tasks/               -- job runner and status transitions
        shared/
          logger/
          schemas/
      drizzle/
      package.json
    client/
      src/
        pages/
          documents/
          rules/
          search/
          chat/
          settings/            -- AI tab, Storage tab, shared setup-guide component
        components/
        lib/
        App.tsx
      package.json
  docs/
    FEATURES.md                -- feature list and delivery phases
    bugs_fix_tracking.md
    superpowers/specs/ and plans/
  package.json
  CLAUDE.md
  WORKLOG.md
```

## Reference Code

`ref_code/` holds selected papra source (AGPL-3.0) as read-only reference. It is never
imported, never copied, never committed. The mandatory rule and its enforcement are in
`CLAUDE.md`. `ref_code/REF_CODE_GUIDE.md` says what each directory demonstrates. The
extraction library (MIME dispatch, tesseract and pdfjs wrappers) and the receipt
pipeline (prompt assembly, validated structured output) are the most useful patterns
for Phase 1.

## Environment Variables

One required variable. Everything else is an optional seed that the database overrides.

```bash
# Required
SETTINGS_ENCRYPTION_KEY=<openssl rand -hex 32>

# Server
PORT=4000
SERVER_BASE_URL=http://localhost:4000
CLIENT_BASE_URL=http://localhost:5173
AUTH_SECRET=<openssl rand -hex 48>
DATABASE_URL=file:./docmind.sqlite

# AI seeds (all optional)
AI_RULES_MODEL=openrouter://google/gemini-2.5-flash
AI_CHAT_MODEL=openrouter://google/gemini-2.5-flash
AI_EMBEDDING_MODEL=openrouter://openai/text-embedding-3-small
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434/v1

# Storage seeds (all optional)
STORAGE_DRIVER=local
DOCUMENT_STORAGE_ROOT=./documents
S3_BUCKET= S3_REGION= S3_ENDPOINT= S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY=
GDRIVE_CLIENT_ID= GDRIVE_CLIENT_SECRET=
ONEDRIVE_CLIENT_ID= ONEDRIVE_CLIENT_SECRET=
```

## Testing

Unit tests for settings resolution order, encryption round trip, model URI parsing,
guide schema, rule application logic, chunking. Integration tests against in-memory
SQLite for every usecase. One driver contract test suite that runs against every
storage driver, local always, S3 against MinIO when available. AI adapters are tested
against recorded HTTP responses, never live keys.

## Key Differences from Papra

| Aspect | Papra | DocMind |
|--------|-------|---------|
| Purpose | Document management | Assistant and secretary with documents as memory |
| Multi-tenancy | Organizations, roles | Single user, multi-user later |
| AI use | Auto-tagging, receipt extraction | Rules engine, search, chat, later notes, wiki, bot |
| AI config | Env vars | Database-backed settings with a UI and setup guides |
| Storage | Fixed drivers from env | Pluggable drivers with OAuth and guides |
| Search | FTS5 only | Hybrid FTS5 and vector |
| Frontend | SolidJS | React |
| Complexity | Many modules, billing | Few modules, no billing |

## Conventions

- Modules are self-contained. Pure logic in `*.models.ts`, orchestration in
  `*.usecases.ts`, data access in `*.repository.ts`.
- Valibot for all validation. Drizzle for all database access.
- Registries are plain objects keyed by id. Adding an entry never means editing a
  switch statement elsewhere.
- No em dashes anywhere.
- Full conventions, the bug fix workflow, and agent usage are in `CLAUDE.md`.

## Non-Goals (for now)

Mobile app, multi-user and sharing, real-time collaboration, webhooks, billing.
Email intake, Telegram, calendar, and the wiki are goals, in later phases.

## License

AGPL-3.0. The LICENSE file is in the repository.
