---
name: review-spec-phase2-find-and-ask
description: Review of the Phase 2 (Find and Ask) design spec, covering embeddings, vector search, chat with citations, auto summary, and inbox triage. Found the sqlite-vec loading plan does not work with @libsql/client, and a settings-module gap that lets a corrupted setting wipe the whole vector index.
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-17-phase-2-find-and-ask-design.md` on
2026-09-17. Full findings in the companion
`docs/superpowers/specs/2026-09-17-phase-2-find-and-ask-design.review.md`.

**Why:** Catch a technically infeasible third-party integration plan and a settings
gap before the D1 spike burns time on the wrong approach.

**How to apply:** Before any sqlite-vec spike, read `node_modules/@libsql/client` and
`libsql` yourself instead of trusting a spec's assumption about SDK capability. In this
case: `@libsql/client`'s public `Client` type has no `loadExtension` method anywhere
(checked `@libsql/core/lib-esm/api.d.ts`), and its file-mode driver is a **connection
pool** (`ConnectionPool` in `@libsql/client/lib-esm/sqlite3.js`) that defaults to up to
20 lazily-created connections for a `file:` URL (`concurrency` defaults to 20 in
`@libsql/core/config.js`), not the single connection the codebase's own
`jobs.runner.ts` comment claims. That pooling also means the existing
`PRAGMA foreign_keys = ON` in `database.ts` is only guaranteed on whichever connection
ran first, silently leaving `ON DELETE CASCADE` unenforced on any later pooled
connection under concurrent load, a Phase 1 bug invisible in tests because tests use
`:memory:` (forced to one connection). The fix I ruled: add `concurrency: 1` to
`createClient()` regardless of which vector-search approach is chosen, and prefer
libsql's built-in native vector column/functions over `sqlite-vec` extension loading
entirely, since native functions work on every pooled connection with no loading step.

Also found: the settings module (`settings.types.ts`, `settings.usecases.ts`,
`settings.schemas.ts`) has no concept of an internal/system-managed setting. Any new
setting a background pipeline needs to write for its own bookkeeping (like this spec's
`ai.embedding.activeDimension`) is, as things stand, also readable and writable through
the public settings API with no protection, which matters more here than usual because
a corrupted dimension value plus a per-document job that "recreates the vec table on
mismatch" (a pattern this spec used) can silently wipe every other document's vectors.
Ruled: add an `internal: boolean` flag to `SettingDefinition`, filter it out of
`listResolved`, and reject public writes to it.

General lesson for future spec/plan reviews on this project: when a spec claims a
specific SDK/driver capability (loadExtension, connection semantics, pooling), verify it
against the actual installed package version in `node_modules` before accepting the
spec's framing, especially when the spec itself flags the claim as uncertain ("needs a
spike"). The spike's design should be informed by that check, not left to discover it
from scratch.

Related: [[review-milestone-c-spec]] (same document-deletion-cascade FK dependency),
[[review-plan-c1]] (same "verify SDK behavior, don't trust the plan's assumption"
lesson, that time for the OpenAI SDK's `extra_body`).
