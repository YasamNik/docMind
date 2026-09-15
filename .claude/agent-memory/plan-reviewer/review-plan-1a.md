---
name: review-plan-1a
description: Review of Milestone A implementation plan (skeleton and upload). Found valibot pipe nesting compile error and wrong buildStorageKey test assertion. Plan is otherwise solid and spec-complete.
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-15-phase-1a-skeleton-and-upload.md` on 2026-09-15 against Milestone A spec and DOCMIND-DESIGN.md.

**Why:** Catch implementation bugs and spec drift before any code is written, when fixes cost nothing.

**How to apply:** The implementer must fix the two Major issues before executing Tasks 2 and 7. The dead config field in Task 2 should be removed to avoid confusion. Future plan reviews should watch for valibot pipe-in-pipe and test assertions that assume a different sanitization path than the implementation.

Key findings:
- Major: Task 2, valibot pipe nests a schema inside another pipe (hexKeySchema returns a pipe schema, cannot be an action in another pipe). Won't compile.
- Major: Task 7 Step 4, buildStorageKey test asserts "u1/d1/x" for input "../../x" but the sanitizer produces "u1/d1/_.._x". Test will fail.
- Minor: Task 2, config.documentStorageRoot is defined but never consumed (dead config). Storage reads root through settings module.
- Spec coverage is complete. All 14 tasks map to spec items. No out-of-scope work.
- Streaming upload with PassThrough/pipeline pattern (Task 10) is correct.
- Hono route ordering (Task 9) is correct in behavior though the comment explaining why is imprecise.
