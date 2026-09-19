---
name: review-spec-storage-drivers
description: Review of the 2026-09-18 S3 + Google Drive storage driver spec, with verified facts about the storage/documents/settings seams that any later storage work must respect
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-18-storage-drivers-gdrive-s3.md` on 2026-09-18.
Verdict: ready after fixing 2 blockers and 5 majors.

**Why:** the spec asserted several things about existing code that turned out to be
subtly wrong, and those errors would have shipped as implementation bugs.

**How to apply:** these are verified facts as of 2026-09-18, re-check before relying on them.

- `documents.usecases.ts` has TWO delete paths. `remove()` is a soft delete that touches
  no storage at all. `purge()` (behind `DELETE /api/documents/:id/permanent`) is the only
  one that calls storage, and it throws at `storageService.getDriver` (i.e.
  `definition.create`) before `driver.delete` is reached. Any "delete is broken on an
  unreachable driver" claim must name purge, and any fix must wrap getDriver too.
- `createStorageService({ settingsService })` has no `db`. Anything in the storage module
  that needs a document count must take an injected counter from server.ts, not import
  `documents.repository`, because documents already imports storage.
- `beforeSet` runs only inside `settingsService.set()`. `setInternal` bypasses it, so any
  guard that matters must be called explicitly by routes that write through setInternal.
- `settings.setInternal` hard-codes `isSecret: false` and JSON-stringifies. Confirmed. The
  only callers are `search.activeDimension` and `types.presetsSeeded`, neither secret, so
  nothing shipped is affected yet.
- `ai.usecases.ts testConnection` does not catch; `testSlot` does. "Mirror the AI test
  route" is ambiguous, say which one.
- `StorageTab.tsx` is still a generic loop over every `storage.*` setting rendering
  `String(setting.value)` into a text Input. Registering any driver with a secret or
  boolean setting breaks that page until the tab is rewritten. Watch task ordering.
- The shared contract suite's largest body is 8 MiB, so a driver with an 8 MiB chunk size
  never executes a multi-chunk upload there. Chunk size must be injectable for the
  chunking loop to be covered.

See [[review-spec-phase2-find-and-ask]] and [[review-spec-smart-fields]] for the same
pattern: spec claims about existing code are the highest-yield thing to verify.
