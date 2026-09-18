---
name: review-spec-document-types
description: Review of the document-types design spec (third sorting-engine dimension replacing the hardcoded documentType enum). Found the per-user seed/migration step has no valid trigger point and settingsRepository has no transaction support.
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-18-document-types-design.md` on 2026-09-18.

**Why:** The spec's own riskiest section, "Seeding and the one time data migration," proposed
running a per-user one-time step "at server start." Verified against the actual code
(`apps/server/src/index.ts`, `apps/server/src/modules/auth/auth.services.ts`) that this
does not work for this codebase's actual startup and signup flow:

- `index.ts` runs migrations and builds the server before `serve()`, with no step that
  enumerates users; nothing in the codebase today lists all rows in the `user` table.
- Sign-up closes after the first account and is enforced in a `databaseHooks.user.create.before`
  hook (`auth.services.ts:26`), which is the natural place per-user setup belongs, not a
  process-start step. On a fresh install the server starts with **zero** users; the user
  signs up later, while the process keeps running. A "run once at start" step never fires
  again until the next restart, so a fresh install's only user gets no preset types and no
  data migration until someone happens to restart the server.
- `settingsRepository.upsert`/`remove` (`settings.repository.ts:10,20`) take no `tx`
  parameter, unlike every other repository in the codebase (`tags.repository.ts`,
  `documents.repository.ts` all accept `tx = db`). So even if the seed step ran at the
  right time, `settingsService.setInternal` (the guard flag) cannot be included in the
  same DB transaction as the preset insert and the data migration without first adding
  transaction support to the settings module. Without that, a crash between the writes
  and the flag-set leaves the flag unset, and a retry re-inserts presets into a
  unique-name index that already has them, throwing a constraint violation.

**How to apply:** For any spec that proposes a "guarded one-time step at server start" for
per-user data: check first whether the codebase actually has a place that knows about
every user at that point in the lifecycle, and whether sign-up is gated (single-user
products often create the one user well after the process starts, not at boot). Prefer a
lazy, idempotent "ensure seeded for this userId" call from the first usecase that needs the
data (e.g. list types, load automatic items), guarded by the same internal-setting flag,
over a boot-time step. Also check whether the settings repository/service actually supports
participating in an outer `db.transaction` before a spec assumes it does; as of this review
it does not.

Also confirmed by tracing the actual functions: `resultsForItems` and `findUnknownReplyIds`
in `rules.models.ts` key purely by `item.id`, never by `item.type`. A spec that says an LLM
reply's `type` discriminator will be checked "beside the existing unknown id filtering"
is describing code that does not exist yet; the discriminator is currently unused by the
matching logic, so validating it is new code, not an extension of an existing pattern.
Mirrors [[lesson-llm-reply-partial-tolerance]]: verify the exact function doing the
filtering, don't infer it from the throwing behavior alone.

Related: [[review-spec-smart-fields]] (same reply-schema-loosening pattern, same module
this spec builds on), [[review-spec-phase2-find-and-ask]] (same internal-setting-flag
mechanism, confirms the flag pattern itself is real and works via `defineSetting({internal:true})`
and `setInternal`, just not transactionally).
