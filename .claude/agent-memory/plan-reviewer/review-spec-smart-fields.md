---
name: review-spec-smart-fields
description: Review outcome and rulings for the smart fields (feature #13) design spec, 2026-09-18
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-18-smart-fields-design.md` (feature #13) on
2026-09-18. Verdict: ready after fixing, not ready as written.

**Why**: two blockers found by reading the actual code the spec touches, not just the
spec text: (1) the reply-schema partial-tolerance gap, see
[[lesson-llm-reply-partial-tolerance]]; (2) the spec's Backfill section claims "summary
rerun already exists" which is false. Grepped the whole server tree for
resummarize/rerun; the only re-trigger mechanism is `jobsService.retry`
(`jobs.usecases.ts`), which only works on jobs whose status is already `failed`
(`jobs.not_retryable` otherwise). There is no way today to re-enqueue a summarize job
for a document that already completed successfully, so the backfill feature is new
usecase code, not reuse, and the spec never says which module writes it despite its own
stated rule that "the fields module does not know about jobs; summary owns the job."

**Ruling on the spec's own open question** (one row vs two for amountTotal/currency):
one row, add a nullable `currency` column to `document_fields`, populated only for the
`amountTotal` row. Reasoning: the table already has the pattern of typed columns used by
a subset of keys (`value_number`, `value_date`), so a `currency` column fits the
established shape; the unique index on `(document_id, key)` guarantees at most one
`amountTotal` per document so pairing is unambiguous; two rows risk an orphan `currency`
row with no meaning if `amountTotal` is dropped by per-row validation while `currency`
survives.

**How to apply**: if a later spec revisits smart fields, or item #32 (renewals and
expiries) extends `document_fields`, check whether these fixes actually landed in the
table (`apps/server/src/modules/fields/fields.tables.ts` once it exists) before assuming
the design is as originally drafted.
