---
name: review-milestone-c-spec
description: Review of Milestone C (sorting) design spec. Key findings on document deletion cascade, failed-extraction Inbox orphans, silent setting-key departures, unbounded prompt size, and dismissed-proposal sameness noise.
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-16-milestone-c-sorting-design.md` on 2026-09-16.

**Why:** Catch data model gaps, backward compat issues, and design-doc departures in the sorting spec before implementation planning starts.

**How to apply:** The implementer must resolve blockers B1 (document deletion cascade) and B2 (extraction failure leaves rule_status pending) before planning. The spec's Departures section needs four additions: setting key rename, applied_by_auto rename, cleanup logic simplification, and structured capability flag. Rulings 1-12 are binding for plan writers.

Key findings:
- Blocker: document deletion leaves orphan rows in document_tags and sort_evaluations (no cascade or cleanup). Ruled ON DELETE CASCADE.
- Blocker: failed extraction leaves rule_status pending, putting documents in Inbox forever. Ruled: set rule_status to failed on extraction failure.
- Major: setting keys silently renamed from design doc (ai.models.* to ai.model.*, ai.providers.*.* to ai.*.*). Not in Departures section.
- Major: category_source not explicitly set to 'auto' in initial mode (section 9.3).
- Major: prompt size unbounded with many auto items (could exceed model context).
- Major: dismissed-proposal sameness uses document.updated_at which changes on rename, causing re-proposal noise.
- 12 rulings made under the autonomy rule covering cascade strategy, tag ordering, uniqueness enforcement, UI slot selection, response shapes, prompt limits, and error sanitization.

Related: [[review-spec-v2]] flagged the applied_by_rule boolean cleanup issue, which this spec resolves by switching to proposal-based cleanup.
