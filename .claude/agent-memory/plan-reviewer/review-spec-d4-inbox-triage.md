---
name: review-spec-d4-inbox-triage
description: Review of D4 inbox triage spec (Phase 2 finale). Found implementation already underway before spec review (schema migration already in the working tree), and an unflagged departure from the parent Phase 2 spec's decision 12.
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-17-d4-inbox-triage-design.md` on 2026-09-17,
against `DOCMIND-DESIGN.md`, `docs/superpowers/specs/2026-09-17-phase-2-find-and-ask-design.md`,
and `docs/FEATURES.md` item #23.

**Why:** This is the last Phase 2 feature; catch schema and process problems before merge,
and check the spec's central claim (reuses the "existing inbox view enhancement" from the
parent spec) against what the parent spec actually decided.

**How to apply:** Two findings worth carrying into future reviews on this project:

1. **Check git status against the spec's file list before reviewing a "draft" spec.**
   On this review, `documents.tables.ts`, `documents.repository.ts`, `documents.usecases.ts`,
   `documents.routes.ts`, `documents.schemas.ts` were already modified (uncommitted, on
   `feat/design-pass`) to add the exact `triageStatus` column, index, and accept endpoints
   the "draft" spec describes, plus a migration file `0009_add_triage_status.sql` (untracked)
   and a `documents.triage.test.ts` (untracked, passing-looking tests). Task 1 and Task 2 of
   the spec's own task breakdown were done before the spec had a review. This means the
   mandatory `plan-reviewer`-before-implementation gate in `CLAUDE.md` was skipped for this
   feature, and a database schema change ("NEEDS USER APPROVAL" per the spec's own section 4
   header) may have been made without going through the "always ask the user before any
   database change" rule in `CLAUDE.md`'s autonomy section. Always `git status` and grep for
   the spec's named columns/files before starting a spec review; do not assume "status: draft"
   means nothing has been built yet on this project.

2. **A spec that changes a parent spec's decision must say so, even under time pressure.**
   The Phase 2 parent spec's decision 12 explicitly designed inbox triage to require no new
   module, no new column, and reuse of the existing inbox view definition (`rule_status` based)
   and existing accept endpoints (PATCH name plus `POST /api/proposals/apply`), specifically
   "to keep the backend simple." D4 does the opposite: new `triageStatus` column, new index, a
   redefined inbox view, two new document routes, and a new evaluations subsystem. The pivot is
   justified (the old inbox definition drops a document from every review queue once initial
   mode successfully auto-sorts it, which defeats feature #23), but D4 never says "this
   supersedes decision 12" or proposes an edit to the parent spec's text. Same class of gap as
   [[review-milestone-c-spec]]'s "Departures section" finding: when a plan or spec silently
   overrides an earlier written decision, require an explicit departures section and a matching
   edit to the source document, don't let the newer document just contradict the older one in
   place.

Other verified, code-grounded findings from this review (useful if this spec comes back for a
second pass): Decision 6 ("inbox falls back to All Documents when empty") contradicts section
6.1/6.3's actual design (InboxPage renders its own empty state, plain redirect to `/inbox`, no
fallback logic anywhere) - pick the simpler one (empty state in place). Section 6.1/6.2's "reuse
CategoryPicker, TagPicker, ProposalsReview from DocumentDetailPage" is not actionable as written:
those are private, unexported functions inside `DocumentDetailPage.tsx` (verified by reading the
file), not shared components; the task breakdown has no extraction step. The already-written
`documents.repository.ts` has an `updateTriageStatus` (singular) method that is dead code; the
real `acceptTriage` usecase uses the generic `repository.update` instead. Decision 10's "ready"
definition ("done (or done/failed with no pending retry)") is circular given this project's own
job-runner semantics (documented in `DOCMIND-DESIGN.md`: a status only becomes `failed` once
retries are exhausted, so "failed with no pending retry" is always true) - the real definition
is just "done or failed, never pending or processing," and does not require inspecting the jobs
table.

Related: [[review-milestone-c-spec]] (departures-section pattern), [[review-spec-phase2-find-and-ask]]
(the parent spec this one builds on, same day), [[review-plan-c3]] (verified-against-actual-code
review style).
