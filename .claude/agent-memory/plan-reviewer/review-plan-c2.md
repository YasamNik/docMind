---
name: review-plan-c2
description: Review of Milestone C2 plan (tags, categories, document links, sidebar, storage key). Found CategoryInput type gap, unverified PRAGMA foreign_keys, and sidebar count mismatch.
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-16-milestone-c2-tags-categories.md` on 2026-09-16.

**Why:** Catch type errors, data integrity assumptions, and UX mismatches before implementation.

**How to apply:** All blockers and the major finding are fixed in the plan text. The implementer should follow the corrected code. The PRAGMA foreign_keys test must pass; if it fails, add the pragma to `createDatabase`.

Key findings fixed:
- Blocker: `CategoryInput` type in `tags-api.ts` was missing `sortOrder`, but `CategoriesPage`'s reorder mutation passed `{ sortOrder }` to `categoriesApi.update`. TypeScript would reject it. Fixed by adding `sortOrder?: number`.
- Blocker: ON DELETE CASCADE depends on libsql's default PRAGMA foreign_keys = ON, but no test verified this. Added a PRAGMA assertion to the database test in Task 1 Step 9.
- Major: Decision 11 said category counts are direct only, but the category filter includes descendants. Sidebar badge "2" with 5 visible documents on click is confusing. Fixed: `CategoryTreeNav` computes recursive counts client-side via a `recursiveCounts` helper; the API response stays direct for the manage page.

Other verifications:
- All table definitions, indexes, foreign keys, and the partial root-only unique index match the spec.
- Migration naming follows existing pattern (0004 after 0003_jobs).
- `documents.repository.ts` `listByUser` signature change from `(userId: string)` to object form: only one caller, also changed. Safe.
- `documents.usecases.ts` `get()` return type broadened with `categoryPath` and `tags`: backward compatible. No consumer breaks.
- `buildStorageKey` signature gains `uploadedAt`: only call site updated, test updated.
- `api.del` generic change: `T = void` default preserves existing callers.
- Extraction catch block `ruleStatus`/`ruleError` addition: correct spread syntax with the right condition.
- No em/en dashes found.
- All 8 tasks sized correctly; each is independently committable and reviewable.

Related: [[review-milestone-c-spec]], [[review-plan-c1]]
