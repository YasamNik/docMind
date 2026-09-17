---
name: review-plan-c3
description: Review of Milestone C3 plan (sorting engine). Fixed missing proposals polling on the Sorting page; verified all 8 tasks, the table schema, fake-adapter seam, prompt/reply, rerun semantics, cleanup, routes, and client code against the spec.
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-17-milestone-c3-sorting-engine.md` on 2026-09-17.

**Why:** Catch data flow errors, UX gaps, and spec divergence before implementation.

**How to apply:** The one major finding is fixed in the plan text. The implementer should follow the corrected SortingPage code (with jobs polling and proposals refetchInterval). Two minor items accepted as-is.

Key findings:
- Major (fixed): SortingPage's RunDialog did not invalidate `["proposals"]` after running, and the page had no polling for new proposals. After a batch run, proposals would never appear until manual refresh. Fixed by adding jobs polling, proposals refetchInterval, and invalidation in onSuccess.
- Minor (accepted): Needs review sub-query on sortEvaluationsTable is not user-scoped; harmless for single-user.
- Minor (accepted): `resolveScopeDocuments("all")` returns documents regardless of extraction status; spec-legal per edge case 5.

All other checks passed:
- Table matches spec section 5 with content_hash, job_id NOT NULL, three correct indexes, ON DELETE CASCADE.
- Single-connection discipline upheld: no db inside tx, LLM call outside transactions, enqueue on tx.
- rule_status transitions correct for initial (pending/processing/done/pending-on-fail) and rerun (never touched).
- Fake-adapter seam threads through createServer/createTestApp exactly as ocrEngine does.
- Prompt/reply validated: untrusted-text guard, full category paths, truncation with note, valibot schema, unknown ids dropped.
- Rerun semantics: all three proposal kinds, manual guards, dismissed sameness with content_hash + item.updated_at.
- Seven routes match spec 9.5/9.7/9.8, all user-scoped and valibot-validated.
- Client covers Sorting page, document page review dialog, and dry-run panel in both editors.
- Regression: only additive changes to existing signatures and queries.

Related: [[review-milestone-c-spec]], [[review-plan-c1]], [[review-plan-c2]]
