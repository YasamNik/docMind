# DocMind: Design and Agent Instructions

An intelligent document management app with AI-powered categorization, natural language
rules, semantic search, and a document chatbot.

This file is the primary instruction for any AI agent working on this project. Read it
fully before writing code.

## Vision

Users upload documents of any type. DocMind extracts text (OCR for images, parsing for
PDFs/DOCX/etc), then applies user-defined natural language rules to automatically
categorize and tag them. All documents are searchable via keyword and semantic search.
A built-in chatbot answers questions about the user's documents using RAG.

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Server | Hono (Node) | Lightweight, fast, runs anywhere. Same as papra reference code. |
| Client | React + Vite | Wide ecosystem, good AI/component libraries. |
| Database | SQLite via libsql + Drizzle ORM | Free, no server needed, single-file deploy. |
| Vector search | sqlite-vec extension | Embeddings in SQLite, no separate service. |
| Auth | better-auth | Lightweight, works with Hono. See `ref_code/auth/`. |
| AI providers | Multi-adapter pattern | OpenRouter, Anthropic, OpenAI, Ollama. See `ref_code/ai/`. |
| Styling | Tailwind CSS | Utility-first, fast iteration. |
| Deploy target | Any $5 VPS, Fly.io, or local | No paid services required. |

## Architecture Overview

```
Browser (React SPA)
  |
  |--- /api/*  ------>  Hono Server (:4000)
                          |
                          |--- SQLite (documents, rules, users, chat)
                          |--- sqlite-vec (document embeddings)
                          |--- AI Adapters (OpenRouter, Anthropic, Ollama, ...)
                          |--- Content Extraction (lecture lib, external OCR)
                          |--- Filesystem (document file storage)
```

Single process. No microservices, no message queues, no Redis. Background tasks
(extraction, rule evaluation, embedding) run in-process via a simple job queue
(same pattern as papra's task system but lighter).

## Data Model

```sql
-- Core
users (id, email, name, created_at)
-- better-auth manages session/account tables

-- Documents
documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  storage_key TEXT NOT NULL,       -- path to file on disk
  extracted_text TEXT,             -- full extracted text
  extraction_status TEXT DEFAULT 'pending',  -- pending | processing | done | failed
  rule_status TEXT DEFAULT 'pending',        -- pending | processing | done
  embedding_status TEXT DEFAULT 'pending',   -- pending | processing | done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

-- Categorization
categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,                  -- for nested categories
  color TEXT
)

tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT
)

document_tags (document_id TEXT, tag_id TEXT, applied_by TEXT) -- 'rule' | 'manual'
document_categories (document_id TEXT, category_id TEXT, applied_by TEXT)

-- Rules Engine
rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,       -- the human language rule
  type TEXT NOT NULL,              -- 'tag' | 'category'
  target_value TEXT NOT NULL,      -- tag name or category name to apply
  is_active INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,     -- higher = evaluated first
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

rule_evaluations (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  matched INTEGER NOT NULL,        -- 0 or 1
  confidence REAL,
  reasoning TEXT,                  -- LLM's explanation
  evaluated_at TEXT NOT NULL
)

-- Vector Search
document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  token_count INTEGER
)
-- sqlite-vec virtual table for embeddings, linked by chunk id

-- Chat
chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL
)

chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'user' | 'assistant'
  content TEXT NOT NULL,
  sources TEXT,                     -- JSON array of {chunk_id, document_id, relevance}
  created_at TEXT NOT NULL
)
```

## Core Features (build order)

### Phase 1: Foundation
1. **Project scaffolding** -- Hono server, React client, Drizzle + libsql, better-auth
2. **Document upload** -- file upload endpoint, filesystem storage, basic document list UI
3. **Content extraction** -- integrate `packages/lecture` for text extraction from
   PDF, images (OCR), DOCX, etc. Run as background task after upload.

### Phase 2: Rules Engine
4. **Rules CRUD** -- API and UI for creating/editing/deleting rules
5. **Rule evaluation pipeline** -- after text extraction, assemble prompt with active
   rules + document text, call LLM for structured evaluation, apply matches
6. **Manual tagging/categorization** -- UI for manual tag/category assignment

### Phase 3: Search
7. **Keyword search** -- SQLite FTS5 on extracted_text
8. **Embedding pipeline** -- chunk documents, generate embeddings via AI adapter,
   store in sqlite-vec
9. **Hybrid search** -- combine FTS5 keyword scores with vector similarity

### Phase 4: Chatbot
10. **RAG pipeline** -- on user question: embed query, retrieve relevant chunks,
    assemble context, call LLM
11. **Chat UI** -- conversation interface with source citations
12. **Chat sessions** -- persist conversations, allow follow-ups

## Rules Engine: Detail

The core differentiator. Users write rules in plain English:

- "Tag as 'Medical' if the document mentions prescriptions, medications, or doctors"
- "Categorize as 'Tax/Receipts' if this is a purchase receipt or invoice"
- "Tag as 'Urgent' if the document contains deadlines within 30 days"

**Evaluation flow:**
1. Document text is extracted (Phase 1)
2. All active rules for the user are loaded
3. A prompt is assembled:
   ```
   You are a document classification assistant. Evaluate each rule against the
   document and return structured results.

   DOCUMENT TEXT (truncated to 8000 chars):
   {document_text}

   RULES TO EVALUATE:
   1. [rule_id] "{rule_description}" -> apply tag/category "{target_value}"
   2. [rule_id] "{rule_description}" -> apply tag/category "{target_value}"
   ...

   For each rule, respond with:
   - matched: true/false
   - confidence: 0.0 to 1.0
   - reasoning: one sentence explaining why
   ```
4. LLM returns structured JSON (use `response_format: json_schema`)
5. Rules with `matched: true` and `confidence >= 0.7` are applied
6. Results stored in `rule_evaluations` for transparency

**Key design decisions:**
- Batch all rules into one LLM call per document (cheaper, faster than one call per rule)
- Store evaluation reasoning so users can understand and tune their rules
- Rules are re-evaluated on demand (user edits a rule, clicks "re-evaluate")
- Confidence threshold is configurable per rule (default 0.7)

## Chatbot: Detail

RAG (Retrieval Augmented Generation) over the user's documents.

**Chunking strategy:**
- Split extracted text into ~500 token chunks with 50 token overlap
- Store chunks in `document_chunks` table
- Generate embeddings via AI adapter (same multi-provider pattern)
- Store in sqlite-vec virtual table

**Query flow:**
1. User asks a question
2. Embed the question
3. Vector search: top 10 most similar chunks
4. Keyword search: FTS5 match on the question terms
5. Merge and re-rank (reciprocal rank fusion)
6. Assemble prompt with top 5 chunks as context
7. Call LLM with system prompt instructing it to answer from the provided context
   and cite sources
8. Stream response to client
9. Save message with source references

## Project Structure

```
docmind/
  ref_code/                    -- papra reference code (read-only, not imported)
    lecture/                   -- content extraction library
    ai/                        -- AI adapter pattern
    receipt-extraction/        -- LLM pipeline example
    content-extraction/        -- extraction strategies
    config/                    -- config pattern
    auth/                      -- better-auth setup
    database/                  -- drizzle + libsql
    shared/                    -- utilities (logger, schemas, streams)
    REF_CODE_GUIDE.md          -- what each section is for
  apps/
    server/
      src/
        index.ts               -- entry point
        modules/
          config/              -- env config (figue + valibot pattern)
          auth/                -- better-auth integration
          database/            -- drizzle + libsql + migrations
          documents/           -- upload, storage, CRUD
          extraction/          -- text extraction pipeline
          rules/               -- rules CRUD + evaluation
          search/              -- FTS5 + vector hybrid search
          chat/                -- RAG chatbot
          ai/                  -- AI adapter layer
          tasks/               -- background job runner
        shared/
          logger/
          schemas/
      drizzle/                 -- migration files
      .env
      package.json
    client/
      src/
        pages/
          documents/           -- document list, upload, detail
          rules/               -- rule editor
          search/              -- search interface
          chat/                -- chatbot UI
        components/
        lib/
        App.tsx
      package.json
  package.json                 -- workspace root
  CLAUDE.md                    -- agent instructions (copy of key parts of this file)
```

## ref_code/ Guide

The `ref_code/` directory contains selected papra source code as reference. It is NOT
imported or used as a dependency. It is there so the AI agent can read real, working
implementations of patterns this project needs.

| Directory | What it demonstrates | When to reference it |
|-----------|---------------------|----------------------|
| `lecture/` | Text extraction from any document type via MIME-type dispatch | Building the extraction module |
| `ai/` | Multi-provider AI adapter (Anthropic, OpenRouter, Ollama, etc) with structured output | Building the AI module |
| `receipt-extraction/` | Complete LLM pipeline: prompt assembly, structured output, validation, DB writes | Building the rules evaluation pipeline |
| `content-extraction/` | Pluggable extraction strategy pattern | If adding external OCR services |
| `config/` | Type-safe env config with figue + valibot | Setting up project config |
| `auth/` | better-auth + Hono integration, session middleware | Setting up auth |
| `database/` | Drizzle ORM + libsql setup, migrations, test utils | Setting up the database |
| `shared/` | Logger, valibot schemas, stream utilities | General utilities |

**How to use reference code:**
- READ it to understand the pattern
- ADAPT it to DocMind's simpler structure (no organizations, no plans, no subscriptions)
- Do NOT copy-paste large blocks. Write fresh code informed by the patterns.
- The AI adapter layer (`ai/`) is the closest to direct reuse. The model routing and
  provider abstraction are directly applicable.

## Environment Variables

```bash
# Server
PORT=4000
SERVER_BASE_URL=http://localhost:4000
CLIENT_BASE_URL=http://localhost:5173

# Auth
AUTH_SECRET=<generate with: openssl rand -hex 48>

# Database
DATABASE_URL=file:./docmind.sqlite

# AI (at least one provider needed)
AI_DEFAULT_MODEL=openrouter://google/gemini-2.5-flash
OPENROUTER_API_KEY=sk-or-v1-...

# Embeddings
EMBEDDING_MODEL=openrouter://openai/text-embedding-3-small
# or use the same provider as AI_DEFAULT_MODEL

# Document storage
DOCUMENT_STORAGE_ROOT=./documents
```

## Key Differences from Papra

| Aspect | Papra | DocMind |
|--------|-------|---------|
| Multi-tenancy | Organizations, invitations, roles | Single user (add multi-user later) |
| AI use | Auto-tagging + receipt extraction | Rules engine + search + chatbot |
| Search | FTS5 only | Hybrid FTS5 + vector |
| Frontend | SolidJS | React |
| Complexity | ~50 modules, subscriptions, Stripe | ~10 modules, no billing |
| Database | SQLite | SQLite + sqlite-vec |

## Conventions

- Modules are self-contained: each has its own config, routes, services, models, types
- Pure logic in `*.models.ts`, orchestration in `*.usecases.ts`
- Config per module in `*.config.ts`, wired into central config
- Valibot for all validation (input, env, LLM output)
- Drizzle for all database access
- No em dashes in docs or code comments
- Tests: unit tests for models, integration tests for usecases

## Non-Goals (for now)

- Mobile app (web-first, add later)
- Multi-user / team features (single user initially)
- Real-time collaboration
- Email ingestion
- Webhooks
- Billing / subscriptions

## License

Choose before going public. Options:
- MIT (permissive, anyone can use)
- AGPL-3.0 (network use = publish source, same as papra)
- Dual license (open core + commercial)
