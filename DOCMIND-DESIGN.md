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
  embedding_status TEXT DEFAULT 'pending',   -- pending | processing | done | failed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

-- Categorization
categories (id, user_id, name, parent_id, color)
tags (id, user_id, name, color)
document_tags (document_id, tag_id, applied_by)           -- 'rule' | 'manual'
document_categories (document_id, category_id, applied_by)

-- Rules Engine
rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,       -- the plain English rule
  type TEXT NOT NULL,              -- 'tag' | 'category'
  target_value TEXT NOT NULL,      -- tag or category name to apply
  confidence_threshold REAL DEFAULT 0.7,
  is_active INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

rule_evaluations (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  matched INTEGER NOT NULL,
  confidence REAL,
  reasoning TEXT,                  -- the model's explanation
  model_id TEXT,                   -- provider://model that produced it
  evaluated_at TEXT NOT NULL
)

-- Vector Search
document_chunks (id, document_id, chunk_index, chunk_text, token_count)
-- sqlite-vec virtual table for embeddings, linked by chunk id. Its dimension is
-- recorded in the system settings ai.embedding.activeModel and ai.embedding.dimensions.

-- Chat
chat_sessions (id, user_id, title, created_at)
chat_messages (id, session_id, role, content, sources, created_at)
-- sources: JSON array of {chunk_id, document_id, relevance}
```

Timestamps are ISO 8601 strings in UTC. All statuses have a `failed` state and an
error column or field, so a job never leaves a row stuck in `processing`.

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
four characters. Sending an empty string clears it. Key rotation is out of scope.

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
- **Local.** Root path, default `./documents`. Keys are `userId/documentId/filename`,
  resolved inside the root with traversal rejected. Guide: absolute paths, permissions,
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
driver. Start redirects with a signed, expiring state value. Callback exchanges the
code, stores the refresh token as a secret, records the connected account's email, and
redirects to settings. Drivers refresh access tokens themselves. A disconnect action
clears tokens. The form shows the exact redirect URI derived from the server base URL,
with a copy button and a note that scheme, host, and port must match exactly.

**Switching drivers.** Each document row records its driver. Changing the active driver
affects new uploads only. Reads resolve the driver from the row. The UI shows how many
documents each driver holds and refuses to clear credentials for a driver that holds
any. A move-documents job is a later item.

**Errors** map to a small set: auth expired, not found, quota, network. Auth expired
surfaces on the settings page as a Reconnect prompt.

## Rules Engine

The Phase 1 differentiator. Users write rules in plain English:

- "Tag as 'Medical' if the document mentions prescriptions, medications, or doctors"
- "Categorize as 'Tax/Receipts' if this is a purchase receipt or invoice"
- "Tag as 'Urgent' if the document contains deadlines within 30 days"

**Evaluation flow.**
1. Text is extracted.
2. All active rules for the user are loaded.
3. One prompt is assembled with the document text (truncated to 8000 characters) and
   every rule, each with its id, description, and target.
4. The rules model returns structured JSON validated by valibot: per rule, matched,
   confidence, reasoning.
5. Rules with matched true and confidence at or above their threshold are applied.
6. Every evaluation is stored in `rule_evaluations` with the model that produced it.

**Design decisions.** One LLM call per document for all rules. Reasoning is stored so
users can tune rules. Re-evaluation on demand: after editing a rule, or for one
document. A dry run tests a rule against a chosen document before saving. The
confidence threshold is per rule. Later phases add inbox triage and rules that learn
from corrections; see `docs/FEATURES.md`.

## Search and Chat

**Chunking.** Roughly 500 tokens per chunk with 50 overlap, stored in `document_chunks`,
embedded through the embedding slot, stored in sqlite-vec.

**Query flow.** Embed the question. Vector search for the top 10 chunks. FTS5 keyword
match on the question. Merge with reciprocal rank fusion. Assemble the top 5 chunks as
context. Call the chat model with a system prompt that answers from the context and
cites sources. Stream to the client. Save the message with source references.

The knowledge wiki in a later phase sits above this: chat reads wiki pages first and
falls back to raw chunks, citing both.

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
