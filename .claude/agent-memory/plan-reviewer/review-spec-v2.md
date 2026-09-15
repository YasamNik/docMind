---
name: review-spec-v2
description: Second-pass review of DOCMIND-DESIGN.md after v1 fixes were applied. All 10 fixes verified. New findings on applied_by_rule cleanup, job-cache sync, retry semantics.
metadata:
  type: project
---

Second review of DOCMIND-DESIGN.md on 2026-09-15 after commit 50d6821 applied all [[review-spec-v1]] findings.

**Why:** Verify fixes landed correctly and catch new issues the fixes introduced, especially around the jobs-table-as-source-of-truth and applied_by_rule flags.

**How to apply:** Implementation of rules re-evaluation must handle tag cleanup when applied_by_rule is a boolean and multiple rules can apply the same tag. Job creation must update document status columns atomically. Manual retry must reset the attempts counter.

All 10 v1 findings verified fixed and consistent across sections.

New findings:
- Major: applied_by_rule is a boolean, so rule deletion/re-eval cannot tell if another rule still justifies the tag. Needs cleanup flow spec or richer data structure.
- Minor: job creation does not explicitly sync document status cache (could show "done" while a re-eval job is pending).
- Minor: manual retry does not specify attempts reset (job would stay failed at 3+ attempts).
- Minor: empty string vs null semantics for secrets is ambiguous.
- Question: re-evaluation job granularity (one per document or batch?) implied but not stated.
