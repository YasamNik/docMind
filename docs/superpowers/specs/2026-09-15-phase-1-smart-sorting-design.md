# Phase 1: Smart sorting

Scope and slicing for the first delivery phase. The system design is in
`DOCMIND-DESIGN.md`; this file only says what Phase 1 builds, in what order, and the
implementation choices that are fixed for it. Feature items refer to `docs/FEATURES.md`.

## Goal

Drop documents in, they get read and filed by plain English rules, and you can see why.
Runs on a VPS. Used daily before Phase 2 starts.

## In scope

Items 1 (sign in), 2 (upload), 3 (extraction), 4 (library), 5 (tags and categories),
6 (rules engine), 9 (settings, OpenRouter and local storage only), 10 (jobs view),
11 (deployment).

Out of scope, even if tempting: search, embeddings, chat, S3 and cloud drivers,
Telegram, summaries. Provider definitions for every provider are built because they
share one adapter, but only the OpenRouter path is exercised end to end.

## Milestones

Each milestone ends in a usable state and is merged before the next starts.

### A. Skeleton and upload

- pnpm workspace, Node 22, `apps/server` (Hono, TypeScript, Drizzle, libsql) and
  `apps/client` (React, Vite, Tailwind, shadcn/ui).
- Config module (figue and valibot pattern), logger, migrations, in-memory SQLite test
  helper.
- Settings module: registry, resolution order, AES-256-GCM secrets under
  `SETTINGS_ENCRYPTION_KEY`, API with masked secrets, in-memory cache.
- Storage module: driver interface, registry, local driver with traversal checks,
  driver contract test suite.
- Auth: better-auth, email and password, sign-up closed after the first user.
- Documents: streamed upload with sha256 and size counting, duplicate detection by
  hash, list, detail, inline preview for PDF and images, rename, download, delete.
- Client shell: sidebar with Documents, Rules, Settings, Jobs. Sign in page.

Outcome: a private place to put files.

### B. Reading

- Jobs table, runner, status transitions, startup recovery, three-attempt limit,
  document status cache updated in the same transaction.
- Extraction job with MIME dispatch: PDF (pdfjs), images (tesseract.js), DOCX,
  text and Markdown. XLSX and PPTX as the last task of the milestone.
- Jobs view: pending, running, failed, error text, retry.
- Extracted text visible on the document page.

Outcome: every file becomes text, and the pipeline is visible.

Decisions fixed for Milestone B (2026-09-16):
- Libraries: pdfjs-dist for PDF text layers, tesseract.js for images, mammoth for DOCX,
  exceljs for XLSX, and PPTX read from the zip's slide XML directly. All permissive.
- Scanned PDFs with no text layer finish as done with empty text and a visible note that
  OCR for scanned PDFs is not available yet. Rendering PDF pages in Node needs a native
  dependency, so it is a later item.
- Runner: polls every two seconds, concurrency two, handlers registered by job type,
  exponential backoff between attempts, three attempts, manual retry resets attempts.
- OCR languages default to English only, as the setting `extraction.ocrLanguages`.
  Language data downloads on first use into the data folder.
- The library badge and the document page poll while a document is pending or
  processing, so status changes appear without a reload.

### C. Sorting

- AI module: provider registry with all definitions and guides, OpenAI-compatible
  adapter (official OpenAI SDK), Anthropic adapter (official Anthropic SDK), service
  with task slots, model listing, test connection. Recorded HTTP responses in tests.
- Settings AI tab generated from the registry: provider cards with key, base URL, test
  button, guide beside the form; three model slots as comboboxes; OpenRouter first and
  preselected.
- Tags and categories: CRUD, colors, nested categories, manual assignment on the
  document page, applied-by flags shown.
- Rules: CRUD with target picked from existing tags or categories, per-rule threshold,
  dry run against a chosen document, evaluation job with one call per document,
  evaluations shown on the document page with reasoning, re-evaluate one document or
  one rule (one job per affected document), cleanup of rule-applied tags per the spec.

Outcome: the smart sorting loop.

### D. Ship

- Dockerfile (single image, server serves the built client), compose file with a
  volume for the database and documents, `.env.example`.
- First-run wizard: encryption key check, first user, OpenRouter key and model slots,
  storage root.
- `CLAUDE.md` "Running locally" filled in with the real commands.

Outcome: runs on the VPS.

## Fixed implementation choices

- Node 22 through nvm, pnpm through corepack. Bun is not part of the toolchain.
- OCR through tesseract.js for portability. Native Tesseract is a later optional
  driver.
- Vitest everywhere. Unit tests for models, integration tests on in-memory SQLite for
  usecases, contract suite for storage drivers, recorded responses for AI adapters.
- Every LLM response is validated with valibot before use. Confidence is 0.0 to 1.0.
- The rules prompt and its output schema are written from the spec. The reference
  receipt pipeline is read once for shape only, per the reference-code rule.
- No em dashes anywhere, including UI copy and setup guides.

## Not decided here

Exact library choices for DOCX, XLSX, and PPTX parsing are picked in the plan after
checking licenses and maintenance. Anything the plan finds missing from this file goes
back to a short brainstorm rather than a guess.
