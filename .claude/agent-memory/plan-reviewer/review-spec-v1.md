---
name: review-spec-v1
description: First review of DOCMIND-DESIGN.md before any code exists. Key findings on missing error columns, job runner gaps, rules FK drift, and tag cardinality ambiguity.
metadata:
  type: project
---

Reviewed DOCMIND-DESIGN.md, CLAUDE.md, and docs/FEATURES.md on 2026-09-15 before Phase 1 implementation.

**Why:** Catch spec contradictions and data model issues before code is written, when changes are cheapest.

**How to apply:** Future reviews of Phase 1 plans or code should verify these items were addressed. Check for rule_error/embedding_error columns, job recovery on crash, rules.target_value FK vs name decision, and document_tags cardinality policy.

Key findings by severity:
- Blocker: spec promises error columns for all statuses but only extraction_error exists in the model.
- Major: no job recovery for crashed processing states; rules.target_value is a name not an FK (rename drift); document_tags cardinality for rule+manual overlap undefined; no generalized jobs table for non-document jobs.
- Minor: OAuth state signing key unspecified; rules.priority has no defined semantics; FEATURES.md "supersedes" note is stale.
