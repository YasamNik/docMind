---
paths:
  - "apps/server/**"
---

# Server module rules

Loaded when working under `apps/server/`. Complements `CLAUDE.md`.

## Module layout

Every feature is one directory under `apps/server/src/modules/<name>/`:

| File | Holds | Tests |
|------|-------|-------|
| `<name>.routes.ts` | Hono routes, input parsing with valibot, calls usecases | integration |
| `<name>.usecases.ts` | orchestration, transactions, calls repositories and services | integration, in-memory SQLite |
| `<name>.models.ts` | pure functions, no IO | unit |
| `<name>.repository.ts` | Drizzle queries only | covered by usecase tests |
| `<name>.config.ts` | env config definitions for this module | unit if logic |
| `<name>.settings.ts` | user-editable settings definitions registered with the settings module | unit |
| `<name>.schemas.ts` | valibot schemas shared by routes and usecases | unit |
| `<name>.types.ts` | types only | none |
| `<name>.tables.ts` | Drizzle table definitions | migration test |

Registries (AI providers, storage drivers, settings definitions) are plain objects keyed
by id. Adding an entry must never require editing a switch statement elsewhere.

## Boundaries

- Routes never touch Drizzle. Usecases never build HTTP responses. Models never import
  from repositories or services.
- Every request body, query, and param is parsed with valibot before use.
- Every LLM response is parsed with valibot before use. Reject and log on failure, mark
  the job failed, never apply partial results.
- Settings values are read through the settings service, never from `process.env`,
  except inside the settings module's own env seeding.
- Secrets never appear in logs, thrown errors, or API responses. Mask to last four chars.

## Background jobs

Every long operation (extraction, rule evaluation, embedding) is a job with a status
column on its row: `pending`, `processing`, `done`, `failed`. Transitions are explicit.
A failure stores the error message on the row. A job never leaves a row in `processing`
after an exception.

## Files and streams

Uploads and downloads are streams end to end. Storage drivers receive and return streams.
Local driver keys resolve inside the configured root; reject traversal before touching
the filesystem.

## Database

- Drizzle for all access. Raw SQL only in migrations and for the sqlite-vec virtual table.
- Migrations are additive where possible. Dropping or renaming a column, adding NOT NULL
  without a default, or changing the vector dimension needs a stated data path.
- Timestamps are ISO 8601 strings in UTC.
