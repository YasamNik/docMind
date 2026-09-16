---
name: review-plan-1b
description: Review of Milestone B (reading) implementation plan. Found doc status cache invariant broken on retriable failure and missing DOCMIND-DESIGN.md updates for new jobs columns. Plan otherwise spec-complete and internally consistent.
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-16-phase-1b-reading.md` on 2026-09-16 against Milestone B spec and DOCMIND-DESIGN.md.

**Why:** Catch correctness and consistency issues in the extraction pipeline plan before implementation, especially around the job-to-document status cache sync invariant.

**How to apply:** The implementer must resolve the doc status cache sync on retriable failures (Major 1) before executing Task 6, and add a step to update DOCMIND-DESIGN.md with the new columns (Major 2). The `createTestApp` call site count is imprecise but not blocking. Minor items are implementation guidance.

Key findings:
- Major: Task 6, extraction handler sets document extractionStatus to "failed" on any error, then rethrows. Runner may set job to "pending" for retry, breaking the design doc's cache invariant. Test at line 1419 asserts this inconsistency.
- Major: Task 1, plan adds max_attempts and available_at to jobs table but Task 8 does not update DOCMIND-DESIGN.md.
- Minor: Task 7, DocumentRow gains extractedText causing list endpoint to return full text for every document.
- Spec coverage is complete. All Milestone B items addressed. Nothing out of scope.
- Transaction patterns (claimNext, onUploaded, requestExtraction, returning()) are correct for Drizzle libsql.
- pdf.js v6 Uint8Array copy, ExcelJS load, and TanStack Query v5 refetchInterval callbacks are all correct.
- Cross-task name and signature consistency verified: JobHandler, JobsService, ExtractorRegistry, createTestApp new shape all match.

Related: [[review-spec-v2]] flagged job-cache sync as a minor gap in the spec.
