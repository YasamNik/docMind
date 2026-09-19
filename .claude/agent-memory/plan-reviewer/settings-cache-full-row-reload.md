---
name: settings-cache-full-row-reload
description: DocMind's settings service caches all of a user's rows together and drops the whole per-user cache on any single-key write; a plan that reasons "read once per process" for one large value should reason about the whole cache instead
metadata:
  type: project
---

`apps/server/src/modules/settings/settings.usecases.ts`: `rowsFor(userId)` calls
`repository.listForUser(userId)` and caches every row for that user in one
`Map<string, Map<string,string>>`, keyed by userId. `resolveRaw` then reads the specific key
out of that already-fully-loaded map. Every `set`, `setInternal`, and `removeInternal` call
does `cache.delete(userId)`, dropping the entire per-user cache, not just the written key.

**Why this matters for review:** a plan that adds one large value (a document, a history
array) to settings and reasons about its cost as "read once per process, cached after that"
is understating the real behavior. The value is reloaded, along with every other setting that
user has, on the next read after *any* write to *any* key by that user (an API key rotation,
an OAuth refresh, a model slot change). The actual cost is still negligible for a single-user
app (one extra JSON.parse of a bounded string, held in one in-memory Map), so this is not a
reason to block a plan, but a plan's own stated reasoning should describe the trigger
correctly (per-user-cache-invalidation, not per-process) so a future reader does not build a
wrong mental model of when the cost is paid.

**How to apply:** when reviewing a plan that adds a settings value and reasons about read
frequency or cache behavior, check `rowsFor`/`cache.delete` in `settings.usecases.ts` for the
current cache granularity before accepting a "read once" or "cached indefinitely" claim.
