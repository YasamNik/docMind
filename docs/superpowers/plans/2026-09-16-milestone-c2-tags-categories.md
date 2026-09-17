# Milestone C2: Tags and Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `tags` module (categories, tags, document links) with CRUD routes, a filterable and enriched documents list (Inbox, Needs review, category and tag filters), the storage key layout change, and the client sidebar, manage pages, and document pickers needed to use it end to end.

**Architecture:** One new server module, `tags`, owns three tables (`categories`, `tags`, `document_tags`) and their CRUD. `documents` gains two columns (`category_id`, `category_source`) and its repository is extended to join against the tags module's tables directly for the enriched, filtered list query, mirroring the existing cross-module repository import from `extraction` into `documents`. The client gets a sidebar with Inbox, Needs review, a category tree, and a tag list, two manage pages, and pickers on the document page.

**Tech Stack:** Nothing new. Same stack as Milestones A, B, and C1 (Hono, Drizzle, libsql, valibot, React, Vite, Tailwind, TanStack Query).

**Spec:** `docs/superpowers/specs/2026-09-16-milestone-c-sorting-design.md` (sections 5, 6, and 8, plus the testing rules in section 10 that apply to C2) and `docs/superpowers/specs/2026-09-16-milestone-c-sorting-design.review.md` (rulings 1, 2, 3, 7, and edge case 6).

## Global Constraints

- Node 22 via nvm, pnpm via corepack. Before any pnpm command in a fresh shell: `source ~/.nvm/nvm.sh && nvm use 22 && corepack enable`.
- Every HTTP input and setting is parsed with valibot before use.
- All database access through Drizzle. Raw SQL only in migrations.
- **Database change: this plan creates one migration** (`categories`, `tags`, `document_tags` tables, and `category_id`, `category_source` columns on `documents`). Per the Autonomy section of CLAUDE.md, the executor must get the user's explicit yes before running `pnpm db:generate` and before committing the generated migration. Task 1 is marked accordingly.
- Error codes are asserted in tests through `expectAppError(run, code)` from `apps/server/src/shared/test/errors.test-utils.ts`.
- Module files are named by role. Tests sit next to the file as `*.test.ts`. Per `.claude/rules/server-modules.md`, a `*.repository.ts` file has no dedicated test file; its behavior is covered by the matching `*.usecases.test.ts`, exactly as `documents.repository.ts` has none today.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- `ref_code/` is reference only. Never copy from it, never import it.
- Conventional commits, subject line first, blank line, then the harness's attribution trailers on their own lines:

```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
```

- Run server tests with `pnpm --filter @docmind/server test`, client tests with `pnpm --filter @docmind/client test`. Run `pnpm typecheck` from the root before every commit.
- Timestamps are ISO 8601 strings in UTC. `autoApply` is stored as integer 0 or 1 in the database, per the spec's data model preamble. `tags.usecases.ts` converts a real boolean into 0 or 1 before every write and converts the stored integer back into a real boolean before every response leaves the service, so `GET`/`POST`/`PATCH` bodies always carry `autoApply: true` or `autoApply: false`, never a raw 0 or 1 (see decision 27).
- `sort_evaluations` and everything in spec section 9 belong to plan C3. This plan does not create that table and does not implement the sorting engine, proposals, or dry run. The data model is left ready for it: `documents.rule_status` and `documents.rule_error` already exist from Milestone B, and category and tag identifiers are stable text ids.

## Decisions made in this plan

Per the autonomy rule in CLAUDE.md and spec section 13, these implementation details are settled here.

1. **Module holds both entities in one file per role.** `apps/server/src/modules/tags/` has exactly one `tags.tables.ts`, `tags.types.ts`, `tags.models.ts`, `tags.schemas.ts`, `tags.repository.ts`, `tags.usecases.ts`, and `tags.routes.ts`, each covering categories, tags, and `document_tags` together, per the spec's own framing ("Directory `apps/server/src/modules/tags/` holds tags and categories"). The returned service and repository objects use flat, clearly prefixed method names (`createTag`, `createCategory`, and so on) rather than nested namespaces, matching the flat shape of `documentsService`, `jobsService`, and `settingsService`.
2. **Id prefixes.** `newTagId()` returns `tag_` plus 16 hex characters and `newCategoryId()` returns `cat_` plus 16 hex characters, generated with `randomBytes(8).toString("hex")`, exactly mirroring `newDocumentId()` (`doc_`) and `newJobId()` (`job_`).
3. **Name normalization.** `tags.schemas.ts`'s `nameSchema` trims with `v.trim()` before length checks (`v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))`). `tags.models.ts` also exports a pure `normalizeName(name)` (`name.trim()`) used a second time in the usecase layer as defense in depth and to keep a testable pure function per the plan's file structure.
4. **Color validation.** `colorSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value like #4f46e5"))`. Stored and returned exactly as given (no case normalization).
5. **Sibling and per-user uniqueness is enforced at the database level** with `UNIQUE` indexes using `COLLATE NOCASE`, per review ruling 3: `categories(user_id, parent_id, name COLLATE NOCASE)` and `tags(user_id, name COLLATE NOCASE)`. Verified against this exact drizzle-orm version (0.45.2): `uniqueIndex(name).on(t.userId, t.parentId, sql\`${t.name} COLLATE NOCASE\`)` generates `CREATE UNIQUE INDEX ... ON categories (user_id, parent_id, "name" COLLATE NOCASE)`, confirmed by a throwaway `drizzle-kit generate` run against an isolated schema during planning.
5a. **Root categories need a second, partial unique index.** SQLite treats every `NULL` as distinct for uniqueness purposes, so `UNIQUE(user_id, parent_id, name COLLATE NOCASE)` does not stop two root categories (`parent_id IS NULL` for both) from sharing a name; confirmed empirically during planning (inserting "Finance" then "finance" both at the root succeeded against that single index). `categoriesTable` therefore also gets `uniqueIndex("categories_user_root_name_idx").on(t.userId, sql\`${t.name} COLLATE NOCASE\`).where(sql\`${t.parentId} is null\`)`, a partial unique index covering the root case, also confirmed empirically to reject a root duplicate while still allowing the same name under two different non-null parents.
6. **Unique constraint violations are mapped to a domain error.** Inserting or updating through Drizzle on this libsql driver throws an error whose `constructor.name` is `DrizzleQueryError` and whose `.cause` is an `LibsqlError` (from `@libsql/client`) with `.code === "SQLITE_CONSTRAINT"`, confirmed empirically against this exact dependency versions during planning. `tags.usecases.ts` defines `function isUniqueConstraintError(error: unknown): boolean { return (error as { cause?: unknown })?.cause instanceof LibsqlError && (error as { cause: LibsqlError }).cause.code === "SQLITE_CONSTRAINT"; }` and catches it around every insert and update, re-throwing `tags.duplicate_name` or `categories.duplicate_name` (409).
7. **Cascade deletes use `ON DELETE CASCADE` foreign keys**, per review ruling 1: `document_tags.document_id` references `documents.id`, `document_tags.tag_id` references `tags.id`, both `{ onDelete: "cascade" }`. Confirmed empirically during planning that `@libsql/client` enforces foreign keys by default (no `PRAGMA foreign_keys = ON` needed) and that deleting a document row cascades to `document_tags`. `documents.category_id` has no foreign key: deleting a category clears the column through application code (see decision 9), it does not delete documents.
8. **Tag ordering is alphabetical, case-insensitive, computed in application code** (review ruling 2), not with a raw-SQL `ORDER BY ... COLLATE NOCASE`, to keep "no raw SQL outside migrations" strict. `tags.models.ts` exports `sortByNameCI<T extends { name: string }>(items: T[]): T[]` using `localeCompare(b.name, undefined, { sensitivity: "base" })`. Categories sort by `sortOrder` then name the same way, via `sortCategories`.
9. **Category deletion and the auto-apply-off cleanup are two different clears.** Deleting a category clears `category_id`/`category_source` on every document pointing at it, regardless of source (the category no longer exists). Turning `autoApply` off on an existing category clears the same two columns only where `category_source = 'auto'`; a manual assignment survives. Both are implemented as one batch `UPDATE` in `tags.repository.ts` (`clearCategoryOnDocuments` and `clearAutoCategoryOnDocuments`). The equivalent behavior for tags (clearing `applied_by_auto` when a tag's `autoApply` is turned off) is explicitly section 9.6, plan C3; this plan does not implement it, matching the task's instruction to leave sorting-engine behavior to C3.
10. **Category path computation** (review ruling 7): `tags.models.ts` exports `buildCategoryPaths(categories, separator = " / ")`, loading every category for the user in one query and walking the parent chain in memory with a `Map`, never a recursive CTE. The separator is `" / "`, matching the spec's own example ("Finance / Tax / Receipts").
11. **Category document counts are direct in the API, recursive in the sidebar.** `documentCount` on a category in the API response counts documents whose `category_id` is exactly that category, not its descendants. The manage page shows this direct count. The sidebar's `CategoryTreeNav` computes recursive counts client-side (own plus all descendants) so the badge matches the filtered list, which includes descendants per spec section 8.1. The `recursiveCounts` helper in `CategoryTreeNav.tsx` does this in one pass over the flat list.
12. **Cross-module repository imports.** `apps/server/src/modules/tags/tags.repository.ts` imports `documentsTable` from `../documents/documents.tables.js` (to count and clear categories on documents). `apps/server/src/modules/documents/documents.repository.ts` imports `categoriesTable`, `tagsTable`, `documentTagsTable` from `../tags/tags.tables.js` and the pure `buildCategoryPaths`/`collectDescendantIds` helpers from `../tags/tags.models.js` (to build the enriched, filtered list). This mirrors the already-existing precedent of `extraction.usecases.ts` importing `createDocumentsRepository` from `../documents/documents.repository.js`. Models stay free of IO and are imported freely in both directions; repositories only touch Drizzle.
13. **`documents.usecases.ts`'s `get()` now returns the enriched row** (`categoryPath`, `tags`) via a new `repository.findByIdWithExtras`, used only by the single-document route. `rename`, `remove`, and `openFile` keep using the existing lightweight `getOrThrow`/`findById` unchanged, so their cost and behavior do not change.
14. **No pagination is introduced.** Tags and categories lists stay small (single user) and unpaginated, matching the existing unpaginated `GET /api/documents`. `GET /api/documents` gains filter query params but no `page`/`limit`.
15. **`view` query param default is `all`.** `documentsListQuerySchema` defaults `view` to `"all"` when absent, matching spec section 8.1.
16. **The Needs review definition used in C2 is the data-model definition minus the proposals clause**, exactly as instructed: `rule_status = 'done' AND category_id IS NULL`. C3 adds `OR EXISTS (an evaluation with outcome 'proposed')` when `sort_evaluations` exists.
17. **The extraction-failure `rule_status` fix ships in this plan, inside Task 4.** It is listed under spec section 5's Rules bullets (not section 9), and Task 4 is the task that gives Inbox/Needs review their real meaning; without the fix a document whose extraction fails forever satisfies the Inbox filter. `extraction.usecases.ts`'s final-attempt catch block also sets `ruleStatus: "failed"` and `ruleError: "Extraction failed"` in the same update.
18. **`buildStorageKey` takes an explicit `uploadedAt: Date`** rather than reading `new Date()` internally, so the year/month prefix is deterministic and unit-testable. `documents.usecases.ts`'s `upload()` computes one `const uploadedAt = new Date()` and reuses its ISO string for `createdAt`/`updatedAt` too, so the row's timestamp and the key's date prefix always agree.
19. **Documents list and detail routes are extended in place**, not split into a new `library` module. `GET /api/documents` gains `categoryId`, `tagId`, `view` query params; both list rows and the single-document response gain `categoryId` (already a plain column), `categoryPath`, and `tags`.
20. **Document category and tag routes live in `tags.routes.ts`**, not `documents.routes.ts`, exactly mirroring how `extraction.routes.ts` registers `POST /api/documents/:id/extract` while importing `documentIdSchema` from the documents module.
21. **`api.del` in the client becomes generic** (`del<T = void>(path): Promise<T>`) because the new tag-link routes return the updated tag list in the body instead of 204, unlike the existing document delete route. Existing callers (`documentsApi.remove`, `categoriesApi.remove`, `tagsApi.remove`) are unaffected since `T` defaults to `void`.
22. **No new client UI dependency is added.** C1's plan proposed a shadcn `Select` component, but the shipped code used a plain `<select>` instead (see `ModelSlotRow.tsx`). This plan follows what actually shipped: native `<select>`, `<input type="range">` for the confidence threshold, a native checkbox styled as a toggle for the automatic switch, and a hex text `<input>` plus a small color swatch for color, all with Tailwind classes, no new npm packages.
23. **Sidebar Inbox and Needs review counts come from the existing list endpoint**, not a new counts endpoint: `useQuery(["documents", { view: "inbox" }])` and `useQuery(["documents", { view: "needs_review" }])`, using `.length`. The spec does not ask for a dedicated count route and a single user's document list is small enough that this is cheap.
24. **"Test on a document" is not built in this plan.** Spec section 8.2 says it is wired in C3. The tags and categories manage pages show a disabled button with a tooltip-free caption ("Available once the sorting engine ships") rather than omitting it, so the layout does not shift when C3 adds it.
25. **Edge case 6 (duplicate upload and sorting) needs no C2-specific handling.** `documentsService.upload`'s existing duplicate-detection path returns the pre-existing document before any new document row, `document_tags` row, or category assignment is created; a duplicate upload simply reuses the existing document's category and tags unchanged. Nothing in this plan touches that path.
26. **Categories also support reordering, not just reparenting.** Spec section 8.2 lists "create, edit, delete, reorder and reparent categories" for the manage screen. `updateCategoryBodySchema` and `CategoryPatch` gain an optional `sortOrder` (a non-negative integer), and `CategoriesPage` gets Up/Down buttons per row that swap `sortOrder` with the adjacent sibling (same `parentId`) via two `PATCH` calls. No drag-and-drop; a full reordering UI is not justified for a small, single-user list.
27. **`autoApply` is presented to clients as a real boolean, never the stored integer.** `categoriesTable`/`tagsTable` declare `autoApply: integer("auto_apply")` with no boolean mode, so `Tag.autoApply` and `Category.autoApply` are `number` (0 or 1) at the Drizzle layer. Returning that number as JSON would be a real bug: the client's `TagRow`/`CategoryRow` types (Task 5) declare `autoApply: boolean`, and an edit form that never touches the automatic checkbox carries the fetched value straight back into its next `PATCH` body; sending the raw integer there would fail `updateTagBodySchema`/`updateCategoryBodySchema`'s `v.optional(v.boolean())`, since valibot's `v.boolean()` rejects a JS number. `tags.usecases.ts` therefore defines two small presentation helpers, `presentTag(tag, documentCount)` and `presentCategory(category, path, documentCount)`, that convert `autoApply` to `tag.autoApply === 1` while assembling every `TagWithCount`/`CategoryWithMeta` returned to a route, in `listTags`, `createTag`, `updateTag`, `listCategories`, `createCategory`, and `updateCategory`. This mirrors how `document_tags.applied_by_auto`/`applied_by_manual` are already converted into `TagChip.auto`/`.manual` booleans in the same module (Task 2's repository). Writes are unaffected: `createTag`/`updateTag`/`createCategory`/`updateCategory` still store `patch.autoApply ? 1 : 0` exactly as before; only the read side changes. `TagWithCount`/`CategoryWithMeta` (`tags.types.ts`) are typed accordingly: `Omit<Tag, "autoApply"> & { autoApply: boolean; documentCount: number }` and `Omit<Category, "autoApply"> & { autoApply: boolean; path: string; documentCount: number }`.

## Interfaces inherited

- `apps/server/src/shared/errors/errors.ts`: `createError({ code, message, status? })` returns `AppError`; `isAppError(error)`.
- `apps/server/src/shared/http/validate.ts`: `parseJsonBody(c, schema)`, `parseOrValidationError(schema, value)`.
- `apps/server/src/shared/test/database.test-utils.ts`: `createTestDatabase()` returns `{ db }`, migrated in-memory.
- `apps/server/src/shared/test/app.test-utils.ts`: `createTestApp({ env?, ocrEngine? })` returns `{ app, db, services, config, signIn }`; `services` is the full `createServer()` return value (so `services.tagsService`, `services.documentsService`, and so on).
- `apps/server/src/shared/test/errors.test-utils.ts`: `expectAppError(run, code)`.
- `apps/server/src/modules/database/database.ts`: `type Database`, `createDatabase({ url })`.
- `apps/server/src/modules/database/schema.ts`: re-exports every module's `*.tables.ts`; this plan adds `export * from "../tags/tags.tables.js";`.
- `apps/server/src/modules/database/database.usecases.ts`: `runMigrations({ db })`, `migrationsFolder`.
- `apps/server/src/modules/documents/documents.tables.ts`: `documentsTable` with columns `id, userId, name, mimeType, sizeBytes, contentHash, storageDriver, storageKey, extractedText, extractionStatus, extractionError, ruleStatus, ruleError, embeddingStatus, embeddingError, createdAt, updatedAt` (this plan adds `categoryId`, `categorySource`).
- `apps/server/src/modules/documents/documents.types.ts`: `Document = typeof documentsTable.$inferSelect`, `NewDocument = typeof documentsTable.$inferInsert`.
- `apps/server/src/modules/documents/documents.models.ts`: `newDocumentId()`, `sanitizeFilename(name)`, `hashingCounter()`, `nowIso()`.
- `apps/server/src/modules/documents/documents.repository.ts`: `createDocumentsRepository({ db })` with `insert(document, tx?)`, `listByUser(userId)` (this plan changes the signature to an options object), `findById({ userId, documentId })`, `findByHash({ userId, contentHash })`, `update({ userId, documentId, patch, tx? })`, `remove({ userId, documentId })`.
- `apps/server/src/modules/documents/documents.usecases.ts`: `createDocumentsService({ db, storageService, onUploaded? })` with `upload`, `list`, `get`, `rename`, `remove`, `openFile`. Error `documents.not_found` (404).
- `apps/server/src/modules/documents/documents.schemas.ts`: `uploadQuerySchema`, `renameBodySchema`, `documentIdSchema` (`/^doc_[0-9a-f]{16}$/`).
- `apps/server/src/modules/storage/storage.usecases.ts`: `buildStorageKey({ userId, documentId, filename })` (this plan changes the signature), `createStorageService({ settingsService })` with `getDriver(userId, driverId)`, `getActiveDriverId(userId)`, `getActiveDriver(userId)`.
- `apps/server/src/modules/storage/drivers/local/local.driver.ts`: `createLocalDriver({ root })`, `resolveInsideRoot(root, key)` (rejects traversal, no assumption about key depth).
- `apps/server/src/modules/extraction/extraction.usecases.ts`: `createExtractionService({ db, documentsService, settingsService, registry })` with `extractDocument`, `handler` (a `JobHandler`), `requestExtraction`. On final-attempt failure it sets `extractionStatus: "failed"`; this plan adds `ruleStatus`/`ruleError` to that same update.
- `apps/server/src/modules/jobs/jobs.usecases.ts` and `jobs.runner.ts`: `createJobsService({ db })`, `createJobRunner({ db, handlers, concurrency?, pollIntervalMs?, logger? })` with `runOnce()`, `start()`, `stop()`.
- `apps/server/src/server.ts`: `createServer({ config, db, ocrEngine? })` returns `{ app, auth, settingsService, storageService, documentsService, jobsService, extractionService, jobRunner, ocrEngine, aiService, getUserId }` (this plan adds `tagsService`).
- Client `src/lib/api.ts`: `api.get<T>(path)`, `api.json<T>(method, path, body)`, `api.del(path)` (this plan makes it generic), `ApiError`.
- Client `src/lib/documents-api.ts`: `documentsApi` with `list()`, `get(id)`, `rename(id, name)`, `remove(id)`, `reextract(id)`, `fileUrl(id, download?)`, `upload(file, onProgress)`; `DocumentRow`, `DocumentDetail`.
- Client `src/App.tsx`: routes under `RequireSession`/`AppShell`; `/rules` is still a `Placeholder`.
- Client `src/components/layout/AppShell.tsx`: exports `AppShell`, currently a flat `links` array rendered as `NavLink`s.
- Client `src/components/ui/`: `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `label`, `sonner`, `table`, `tabs-nav`. No `select`, `switch`, `slider`, or `textarea` component exists; this plan does not add any (decision 22).
- Client `src/pages/documents/DocumentsPage.tsx` and `DocumentDetailPage.tsx`: existing list and detail pages, patterns for `useQuery`/`useMutation`/`refetchInterval`.

## File structure

### Server: `apps/server/src/modules/tags/`

| File | Responsibility |
|------|-----------------|
| `tags.tables.ts` | Drizzle tables: `categoriesTable`, `tagsTable`, `documentTagsTable` |
| `tags.types.ts` | `Category`, `NewCategory`, `Tag`, `NewTag`, `DocumentTag`, `NewDocumentTag`, `TagChip`, `CategoryWithMeta`, `TagWithCount` |
| `tags.models.ts` | Pure functions: `newTagId`, `newCategoryId`, `normalizeName`, `buildCategoryPaths`, `collectDescendantIds`, `wouldCreateCycle`, `nextSortOrder`, `sortByNameCI`, `sortCategories`, `nowIso` |
| `tags.schemas.ts` | Valibot schemas: `nameSchema`, `colorSchema`, `tagDescriptionSchema`, `categoryDescriptionSchema`, `thresholdSchema`, `tagIdSchema`, `categoryIdSchema`, create/update body schemas, `documentCategoryBodySchema` |
| `tags.repository.ts` | Drizzle queries for categories, tags, `document_tags`, and the document-side batch clears |
| `tags.usecases.ts` | `createTagsService({ db })`: CRUD for tags and categories, document category/tag assignment |
| `tags.routes.ts` | `registerTagsRoutes({ app, tagsService, getUserId })`: `/api/tags*`, `/api/categories*`, `/api/documents/:id/category`, `/api/documents/:id/tags/:tagId` |
| `tags.models.test.ts` | Unit tests |
| `tags.usecases.test.ts` | Integration tests on in-memory SQLite |
| `tags.routes.test.ts` | Integration tests through the HTTP app |

Modified server files: `apps/server/src/modules/documents/documents.tables.ts`, `documents.types.ts`, `documents.repository.ts`, `documents.usecases.ts`, `documents.routes.ts`, `documents.schemas.ts`, `documents.usecases.test.ts`, `documents.routes.test.ts`; `apps/server/src/modules/database/schema.ts`; `apps/server/src/modules/storage/storage.usecases.ts`, `storage.usecases.test.ts`; `apps/server/src/modules/extraction/extraction.usecases.ts`, `extraction.usecases.test.ts`; `apps/server/src/modules/database/database.test.ts`; `apps/server/src/server.ts`.

### Client

| File | Responsibility |
|------|-----------------|
| `src/lib/api.ts` | Modified: `del` becomes generic |
| `src/lib/documents-api.ts` | Modified: `list(filters?)`, `DocumentRow` gains `categoryId`, `categoryPath`, `tags` |
| `src/lib/tags-api.ts` | New: `tagsApi`, `categoriesApi`, `documentCategorizationApi`, shared `TagChip`/`TagRow`/`CategoryRow` types |
| `src/components/layout/AppShell.tsx` | Modified: sidebar grows Inbox/Needs review/category tree/tag list |
| `src/components/layout/CategoryTreeNav.tsx` | New: recursive category tree navigation with counts |
| `src/pages/tags/TagsPage.tsx` | New: manage tags |
| `src/pages/categories/CategoriesPage.tsx` | New: manage categories |
| `src/pages/documents/DocumentsPage.tsx` | Modified: reads filters from the URL, shows category and tag columns |
| `src/pages/documents/DocumentDetailPage.tsx` | Modified: category picker, tag picker with chips |
| `src/App.tsx` | Modified: adds `/tags`, `/categories` routes |

Following existing convention, every `.tsx` component gets a matching `.test.tsx` beside it (`AiTab.test.tsx` next to `AiTab.tsx` is the precedent).

---

### Task 1: Tables, migration, types, and models

**DATABASE CHANGE: the executor must obtain the user's explicit yes before running `pnpm db:generate` and before committing the generated migration files under `apps/server/drizzle/`. Do not run the migration or commit it silently.**

**Files:**
- Create: `apps/server/src/modules/tags/tags.tables.ts`, `tags.types.ts`, `tags.models.ts`, `tags.models.test.ts`
- Modify: `apps/server/src/modules/documents/documents.tables.ts`, `apps/server/src/modules/database/schema.ts`, `apps/server/src/modules/database/database.test.ts`
- Generate (after approval): `apps/server/drizzle/0004_tags_and_categories.sql`, `apps/server/drizzle/meta/0004_snapshot.json`, `apps/server/drizzle/meta/_journal.json` (updated)

**Interfaces:**
- Consumes: nothing outside this task besides `drizzle-orm/sqlite-core` (`index`, `integer`, `primaryKey`, `real`, `sqliteTable`, `text`, `uniqueIndex`) and `drizzle-orm`'s `sql` tag.
- Produces: `categoriesTable`, `tagsTable`, `documentTagsTable`, `Category`, `NewCategory`, `Tag`, `NewTag`, `DocumentTag`, `NewDocumentTag`, `TagChip`, `newTagId()`, `newCategoryId()`, `normalizeName(name)`, `buildCategoryPaths(categories, separator?)`, `collectDescendantIds(categories, rootId)`, `wouldCreateCycle(categories, id, newParentId)`, `nextSortOrder(siblingSortOrders)`, `sortByNameCI(items)`, `sortCategories(categories)`, `nowIso()`. `documentsTable` gains `categoryId`, `categorySource` columns, consumed by Task 4.

- [ ] **Step 1: Write the failing model tests**

`apps/server/src/modules/tags/tags.models.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  buildCategoryPaths,
  collectDescendantIds,
  newCategoryId,
  newTagId,
  nextSortOrder,
  normalizeName,
  sortByNameCI,
  sortCategories,
  wouldCreateCycle,
} from "./tags.models.js";

type Node = { id: string; parentId: string | null; name: string };

describe("tags models", () => {
  it("makes prefixed ids", () => {
    expect(newTagId()).toMatch(/^tag_[0-9a-f]{16}$/);
    expect(newCategoryId()).toMatch(/^cat_[0-9a-f]{16}$/);
    expect(newTagId()).not.toBe(newTagId());
  });

  it("trims names", () => {
    expect(normalizeName("  Rent  ")).toBe("Rent");
    expect(normalizeName("Rent")).toBe("Rent");
  });

  describe("buildCategoryPaths", () => {
    const tree: Node[] = [
      { id: "cat_a", parentId: null, name: "Finance" },
      { id: "cat_b", parentId: "cat_a", name: "Tax" },
      { id: "cat_c", parentId: "cat_b", name: "Receipts" },
      { id: "cat_d", parentId: null, name: "Personal" },
    ];

    it("builds full paths from the root with the default separator", () => {
      const paths = buildCategoryPaths(tree);
      expect(paths.get("cat_a")).toBe("Finance");
      expect(paths.get("cat_b")).toBe("Finance / Tax");
      expect(paths.get("cat_c")).toBe("Finance / Tax / Receipts");
      expect(paths.get("cat_d")).toBe("Personal");
    });

    it("accepts a custom separator", () => {
      expect(buildCategoryPaths(tree, " > ").get("cat_c")).toBe("Finance > Tax > Receipts");
    });

    it("returns an empty map for an empty list", () => {
      expect(buildCategoryPaths([]).size).toBe(0);
    });
  });

  describe("collectDescendantIds", () => {
    const tree: Node[] = [
      { id: "cat_a", parentId: null, name: "Finance" },
      { id: "cat_b", parentId: "cat_a", name: "Tax" },
      { id: "cat_c", parentId: "cat_b", name: "Receipts" },
      { id: "cat_d", parentId: null, name: "Personal" },
    ];

    it("collects every descendant at any depth", () => {
      expect(collectDescendantIds(tree, "cat_a").sort()).toEqual(["cat_b", "cat_c"]);
      expect(collectDescendantIds(tree, "cat_b")).toEqual(["cat_c"]);
      expect(collectDescendantIds(tree, "cat_c")).toEqual([]);
      expect(collectDescendantIds(tree, "cat_d")).toEqual([]);
    });
  });

  describe("wouldCreateCycle", () => {
    const tree: Node[] = [
      { id: "cat_a", parentId: null, name: "Finance" },
      { id: "cat_b", parentId: "cat_a", name: "Tax" },
      { id: "cat_c", parentId: "cat_b", name: "Receipts" },
    ];

    it("rejects self-parenting", () => {
      expect(wouldCreateCycle(tree, "cat_a", "cat_a")).toBe(true);
    });

    it("rejects making a category a child of its own descendant", () => {
      expect(wouldCreateCycle(tree, "cat_a", "cat_c")).toBe(true);
      expect(wouldCreateCycle(tree, "cat_b", "cat_c")).toBe(true);
    });

    it("allows a valid move", () => {
      expect(wouldCreateCycle(tree, "cat_c", "cat_a")).toBe(false);
    });

    it("allows moving to the root", () => {
      expect(wouldCreateCycle(tree, "cat_c", null)).toBe(false);
    });
  });

  describe("nextSortOrder", () => {
    it("is 0 for the first sibling", () => {
      expect(nextSortOrder([])).toBe(0);
    });

    it("is one past the current maximum", () => {
      expect(nextSortOrder([0, 3, 1])).toBe(4);
    });
  });

  describe("sortByNameCI", () => {
    it("sorts case-insensitively", () => {
      const items = [{ name: "rent" }, { name: "Bills" }, { name: "Apartment" }];
      expect(sortByNameCI(items).map((i) => i.name)).toEqual(["Apartment", "Bills", "rent"]);
    });
  });

  describe("sortCategories", () => {
    it("sorts by sortOrder then name case-insensitively", () => {
      const items = [
        { name: "zzz", sortOrder: 1 },
        { name: "aaa", sortOrder: 1 },
        { name: "mmm", sortOrder: 0 },
      ];
      expect(sortCategories(items).map((i) => i.name)).toEqual(["mmm", "aaa", "zzz"]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- tags.models`
Expected: FAIL, cannot find module `./tags.models.js`.

- [ ] **Step 3: Write the tags tables**

`apps/server/src/modules/tags/tags.tables.ts`:
```ts
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { documentsTable } from "../documents/documents.tables.js";

export const categoriesTable = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    color: text("color"),
    description: text("description").notNull().default(""),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.7),
    autoApply: integer("auto_apply").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("categories_user_parent_idx").on(t.userId, t.parentId),
    uniqueIndex("categories_user_parent_name_idx").on(t.userId, t.parentId, sql`${t.name} COLLATE NOCASE`),
    // SQLite treats every NULL as distinct for uniqueness, so the index above does not
    // stop two root categories (parent_id NULL) from sharing a name. A second, partial
    // unique index covers exactly that case. Confirmed empirically during planning:
    // without this index, inserting "Finance" and "finance" both at the root succeeds.
    uniqueIndex("categories_user_root_name_idx")
      .on(t.userId, sql`${t.name} COLLATE NOCASE`)
      .where(sql`${t.parentId} is null`),
  ],
);

export const tagsTable = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    description: text("description").notNull().default(""),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.7),
    autoApply: integer("auto_apply").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("tags_user_idx").on(t.userId), uniqueIndex("tags_user_name_idx").on(t.userId, sql`${t.name} COLLATE NOCASE`)],
);

export const documentTagsTable = sqliteTable(
  "document_tags",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tagsTable.id, { onDelete: "cascade" }),
    appliedByManual: integer("applied_by_manual").notNull().default(0),
    appliedByAuto: integer("applied_by_auto").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.tagId] }), index("document_tags_tag_idx").on(t.tagId)],
);
```

- [ ] **Step 4: Add the two columns and the index to `documentsTable`**

In `apps/server/src/modules/documents/documents.tables.ts`, change the import line and add the two columns plus the index:
```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documentsTable = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    contentHash: text("content_hash"),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    extractedText: text("extracted_text"),
    extractionStatus: text("extraction_status").notNull().default("pending"),
    extractionError: text("extraction_error"),
    ruleStatus: text("rule_status").notNull().default("pending"),
    ruleError: text("rule_error"),
    embeddingStatus: text("embedding_status").notNull().default("pending"),
    embeddingError: text("embedding_error"),
    categoryId: text("category_id"),
    categorySource: text("category_source"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("documents_user_category_idx").on(t.userId, t.categoryId)],
);
```

`Document` and `NewDocument` (in `documents.types.ts`) are inferred from this table, so the two new columns are now required (though nullable) properties of the `Document` type. `documents.usecases.ts`'s `upload(...)` builds one full `Document` object literal; without this fix `pnpm typecheck` fails right after this step with "Property 'categoryId' is missing". Read `apps/server/src/modules/documents/documents.usecases.ts` first, then in `upload(...)`, change:
```ts
        extractionStatus: "pending",
        extractionError: null,
        ruleStatus: "pending",
        ruleError: null,
        embeddingStatus: "pending",
        embeddingError: null,
        createdAt: timestamp,
```
to:
```ts
        extractionStatus: "pending",
        extractionError: null,
        ruleStatus: "pending",
        ruleError: null,
        embeddingStatus: "pending",
        embeddingError: null,
        categoryId: null,
        categorySource: null,
        createdAt: timestamp,
```
Run `pnpm --filter @docmind/server typecheck` now to confirm this closes the gap before continuing; Task 4 revisits `upload(...)` again for the storage key change, but this fix must land now so every task's typecheck step actually passes.

- [ ] **Step 5: Re-export the new tables from the shared schema**

In `apps/server/src/modules/database/schema.ts`:
```ts
// Every module's tables are re-exported here so drizzle-kit and the migrator see them.
export * from "../settings/settings.tables.js";
export * from "../auth/auth.tables.js";
export * from "../documents/documents.tables.js";
export * from "../jobs/jobs.tables.js";
export * from "../tags/tags.tables.js";
```

- [ ] **Step 6: Write `tags.types.ts`**

`apps/server/src/modules/tags/tags.types.ts`:
```ts
import type { categoriesTable, documentTagsTable, tagsTable } from "./tags.tables.js";

export type Category = typeof categoriesTable.$inferSelect;
export type NewCategory = typeof categoriesTable.$inferInsert;
export type Tag = typeof tagsTable.$inferSelect;
export type NewTag = typeof tagsTable.$inferInsert;
export type DocumentTag = typeof documentTagsTable.$inferSelect;
export type NewDocumentTag = typeof documentTagsTable.$inferInsert;

export type TagChip = { id: string; name: string; color: string | null; auto: boolean; manual: boolean };

export type TagWithCount = Omit<Tag, "autoApply"> & { autoApply: boolean; documentCount: number };
export type CategoryWithMeta = Omit<Category, "autoApply"> & { autoApply: boolean; path: string; documentCount: number };
```

- [ ] **Step 7: Write `tags.models.ts`**

`apps/server/src/modules/tags/tags.models.ts`:
```ts
import { randomBytes } from "node:crypto";

export function newTagId() {
  return `tag_${randomBytes(8).toString("hex")}`;
}

export function newCategoryId() {
  return `cat_${randomBytes(8).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeName(name: string): string {
  return name.trim();
}

export type CategoryNode = { id: string; parentId: string | null; name: string };

export function buildCategoryPaths(categories: CategoryNode[], separator = " / "): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const paths = new Map<string, string>();

  function pathFor(id: string, seen: Set<string>): string {
    if (paths.has(id)) return paths.get(id)!;
    const node = byId.get(id);
    if (!node) return "";
    if (seen.has(id)) return node.name;
    seen.add(id);
    const parentPath = node.parentId ? pathFor(node.parentId, seen) : "";
    const full = parentPath ? `${parentPath}${separator}${node.name}` : node.name;
    paths.set(id, full);
    return full;
  }

  for (const c of categories) pathFor(c.id, new Set());
  return paths;
}

export function collectDescendantIds(categories: CategoryNode[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c.id);
    childrenByParent.set(c.parentId, list);
  }
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenByParent.get(current) ?? []) {
      result.push(child);
      stack.push(child);
    }
  }
  return result;
}

export function wouldCreateCycle(categories: CategoryNode[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  const descendants = new Set(collectDescendantIds(categories, id));
  return descendants.has(newParentId);
}

export function nextSortOrder(siblingSortOrders: number[]): number {
  return siblingSortOrders.length === 0 ? 0 : Math.max(...siblingSortOrders) + 1;
}

export function sortByNameCI<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function sortCategories<T extends { name: string; sortOrder: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
```

- [ ] **Step 8: Run the model tests**

Run: `pnpm --filter @docmind/server test -- tags.models`
Expected: PASS, all describe blocks green.

- [ ] **Step 9: Add a migration test that the new tables and columns exist**

In `apps/server/src/modules/database/database.test.ts`, add a second test (keep the existing one):
```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";

describe("database", () => {
  it("applies migrations to an in-memory database", async () => {
    const { db } = await createTestDatabase();
    const rows = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
    );
    expect(rows.length).toBe(1);
  });

  it("creates the tags module tables and the documents category columns", async () => {
    const { db } = await createTestDatabase();
    const tables = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name in ('categories', 'tags', 'document_tags')`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual(["categories", "document_tags", "tags"]);
    const columns = await db.all<{ name: string }>(sql`pragma table_info(documents)`);
    const names = columns.map((c) => c.name);
    expect(names).toContain("category_id");
    expect(names).toContain("category_source");
  });

  it("has foreign key enforcement enabled", async () => {
    const { db } = await createTestDatabase();
    const [row] = await db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`);
    expect(row.foreign_keys).toBe(1);
  });
});
```

This test is written now but only passes once the migration exists (Step 11); it is expected to fail until then.

- [ ] **Step 10: Run typecheck to confirm the schema compiles**

Run: `pnpm typecheck`
Expected: PASS. `pnpm db:generate` (drizzle-kit) reads the compiled schema graph via `tsx`/esbuild, not `tsc`, but a clean typecheck here catches import mistakes before generating.

- [ ] **Step 11: Stop and get the user's explicit yes before running the migration**

Show the user this plan step and the table definitions above. Do not proceed to Step 12 without an explicit yes, per CLAUDE.md's Autonomy section and the DATABASE CHANGE note at the top of this task.

- [ ] **Step 12: Generate the migration**

Run from `apps/server`:
```bash
source ~/.nvm/nvm.sh && nvm use 22 && corepack enable
cd apps/server && pnpm db:generate --name tags_and_categories
```
Expected output file: `apps/server/drizzle/0004_tags_and_categories.sql`. Its shape must match (verified against this exact drizzle-orm/drizzle-kit version during planning):
```sql
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`color` text,
	`description` text DEFAULT '' NOT NULL,
	`confidence_threshold` real DEFAULT 0.7 NOT NULL,
	`auto_apply` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_user_parent_idx` ON `categories` (`user_id`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_parent_name_idx` ON `categories` (`user_id`,`parent_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_root_name_idx` ON `categories` (`user_id`,"name" COLLATE NOCASE) WHERE "categories"."parent_id" is null;--> statement-breakpoint
CREATE TABLE `document_tags` (
	`document_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`applied_by_manual` integer DEFAULT 0 NOT NULL,
	`applied_by_auto` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`document_id`, `tag_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_tags_tag_idx` ON `document_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`description` text DEFAULT '' NOT NULL,
	`confidence_threshold` real DEFAULT 0.7 NOT NULL,
	`auto_apply` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_user_idx` ON `tags` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name_idx` ON `tags` (`user_id`,"name" COLLATE NOCASE);--> statement-breakpoint
ALTER TABLE `documents` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `category_source` text;--> statement-breakpoint
CREATE INDEX `documents_user_category_idx` ON `documents` (`user_id`,`category_id`);
```
If the generated file differs only in cosmetic ways (column order within a statement, quoting style), that is fine. If it is missing `COLLATE NOCASE`, a foreign key, or the composite primary key, stop and re-check the table definitions in Step 3 before proceeding; do not hand-edit the generated SQL to patch over a schema mistake.

- [ ] **Step 13: Run the database and model tests**

Run: `pnpm --filter @docmind/server test -- database tags.models`
Expected: PASS, including the new migration test from Step 9.

- [ ] **Step 14: Run the full server test suite**

Run: `pnpm --filter @docmind/server test`
Expected: PASS. No existing test references `documents.tables.ts`'s column list directly, so adding two nullable columns is additive and safe.

- [ ] **Step 15: Commit**

Only after Step 11's explicit yes.

```bash
git add apps/server/src/modules/tags/tags.tables.ts \
        apps/server/src/modules/tags/tags.types.ts \
        apps/server/src/modules/tags/tags.models.ts \
        apps/server/src/modules/tags/tags.models.test.ts \
        apps/server/src/modules/documents/documents.tables.ts \
        apps/server/src/modules/database/schema.ts \
        apps/server/src/modules/database/database.test.ts \
        apps/server/drizzle
git commit -m "$(cat <<'EOF'
feat(server): add categories, tags, and document_tags tables

Adds the tags module's three tables (categories, tags, document_tags)
with case-insensitive unique sibling and per-user names, cascade
deletes for document links, and the category_id/category_source
columns on documents. Includes pure helpers for tree paths, cycle
detection, and ordering.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 2: Repository and usecases for tags and categories

**Files:**
- Create: `apps/server/src/modules/tags/tags.repository.ts`, `tags.usecases.ts`, `tags.usecases.test.ts`

**Interfaces:**
- Consumes: `categoriesTable`, `tagsTable`, `documentTagsTable` from `tags.tables.ts`; `Category`, `NewCategory`, `Tag`, `NewTag`, `TagChip` from `tags.types.ts`; `newTagId`, `newCategoryId`, `nowIso`, `normalizeName`, `buildCategoryPaths`, `collectDescendantIds`, `wouldCreateCycle`, `nextSortOrder`, `sortByNameCI`, `sortCategories` from `tags.models.ts`; `documentsTable` from `../documents/documents.tables.js`; `createError` from `../../shared/errors/errors.js`; `Database` from `../database/database.js`; `LibsqlError` from `@libsql/client`.
- Produces: `createTagsRepository({ db })` and `createTagsService({ db })`, both exported from this task, consumed by Task 3 (routes) and Task 4 (documents list enrichment, which imports the tables and models directly, not the service).
  - `createTagsService({ db })` returns: `listTags(userId)`, `createTag({ userId, name, color?, description?, confidenceThreshold?, autoApply? })`, `updateTag({ userId, tagId, patch })`, `deleteTag({ userId, tagId })`, `listCategories(userId)`, `createCategory({ userId, name, parentId?, color?, description?, confidenceThreshold?, autoApply? })`, `updateCategory({ userId, categoryId, patch })`, `deleteCategory({ userId, categoryId })`, `setDocumentCategory({ userId, documentId, categoryId })`, `setDocumentTag({ userId, documentId, tagId })`, `clearDocumentTag({ userId, documentId, tagId })`.
  - Errors: `tags.not_found` (404), `tags.duplicate_name` (409), `categories.not_found` (404), `categories.duplicate_name` (409), `categories.invalid_parent` (400), `documents.not_found` (404, reused from the documents module for the document-link methods).

- [ ] **Step 1: Write the failing integration tests**

`apps/server/src/modules/tags/tags.usecases.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { newDocumentId, nowIso } from "../documents/documents.models.js";
import type { NewDocument } from "../documents/documents.types.js";
import { createTagsRepository } from "./tags.repository.js";
import { createTagsService } from "./tags.usecases.js";

const userId = "user-1";
let tags: ReturnType<typeof createTagsService>;
let tagsRepository: ReturnType<typeof createTagsRepository>;
let documents: ReturnType<typeof createDocumentsRepository>;

beforeEach(async () => {
  const { db } = await createTestDatabase();
  tags = createTagsService({ db });
  tagsRepository = createTagsRepository({ db });
  documents = createDocumentsRepository({ db });
});

function documentFixture(overrides: Partial<NewDocument> = {}): NewDocument {
  const t = nowIso();
  return {
    id: newDocumentId(),
    userId,
    name: "doc.txt",
    mimeType: "text/plain",
    sizeBytes: 10,
    contentHash: null,
    storageDriver: "local",
    storageKey: "key",
    extractedText: null,
    extractionStatus: "done",
    extractionError: null,
    ruleStatus: "done",
    ruleError: null,
    embeddingStatus: "pending",
    embeddingError: null,
    categoryId: null,
    categorySource: null,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe("tags service", () => {
  it("creates, lists alphabetically, updates, and deletes a tag", async () => {
    await tags.createTag({ userId, name: "Rent" });
    await tags.createTag({ userId, name: "apartment" });
    const list = await tags.listTags(userId);
    expect(list.map((t) => t.name)).toEqual(["apartment", "Rent"]);
    expect(list[0]).toMatchObject({ documentCount: 0, autoApply: true, confidenceThreshold: 0.7, description: "" });

    const rent = list.find((t) => t.name === "Rent")!;
    const updated = await tags.updateTag({ userId, tagId: rent.id, patch: { color: "#ff0000", description: "Monthly rent" } });
    expect(updated).toMatchObject({ color: "#ff0000", description: "Monthly rent" });

    await tags.deleteTag({ userId, tagId: rent.id });
    expect((await tags.listTags(userId)).map((t) => t.id)).not.toContain(rent.id);
  });

  it("rejects a sibling tag name that differs only by case", async () => {
    await tags.createTag({ userId, name: "Rent" });
    await expectAppError(() => tags.createTag({ userId, name: "rent" }), "tags.duplicate_name");
    await expectAppError(() => tags.createTag({ userId, name: "RENT" }), "tags.duplicate_name");
  });

  it("scopes tags by user and 404s on a missing or foreign tag", async () => {
    const tag = await tags.createTag({ userId, name: "Rent" });
    await expectAppError(() => tags.updateTag({ userId: "someone-else", tagId: tag.id, patch: { name: "x" } }), "tags.not_found");
    await expectAppError(() => tags.deleteTag({ userId, tagId: "tag_0000000000000000" }), "tags.not_found");
  });

  it("creates nested categories, lists with paths and sort order, updates, and deletes", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    const list = await tags.listCategories(userId);
    expect(list.find((c) => c.id === tax.id)).toMatchObject({ path: "Finance / Tax", parentId: finance.id, documentCount: 0 });

    const renamed = await tags.updateCategory({ userId, categoryId: tax.id, patch: { name: "Taxes" } });
    expect(renamed.name).toBe("Taxes");

    await tags.deleteCategory({ userId, categoryId: tax.id });
    expect((await tags.listCategories(userId)).map((c) => c.id)).not.toContain(tax.id);
  });

  it("assigns the next sort order to new siblings and orders by sortOrder then name", async () => {
    const a = await tags.createCategory({ userId, name: "zzz" });
    const b = await tags.createCategory({ userId, name: "aaa" });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    const list = await tags.listCategories(userId);
    expect(list.map((c) => c.name)).toEqual(["zzz", "aaa"]);
  });

  it("reorders siblings by patching sortOrder directly", async () => {
    const a = await tags.createCategory({ userId, name: "zzz" });
    const b = await tags.createCategory({ userId, name: "aaa" });
    // Swap so "zzz" (created first, sortOrder 0) sorts after "aaa" despite the name order.
    await tags.updateCategory({ userId, categoryId: a.id, patch: { sortOrder: 1 } });
    await tags.updateCategory({ userId, categoryId: b.id, patch: { sortOrder: 0 } });
    const list = await tags.listCategories(userId);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it("rejects a sibling category name that differs only by case, but allows the same name under a different parent", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    await tags.createCategory({ userId, name: "Receipts", parentId: finance.id });
    await expectAppError(() => tags.createCategory({ userId, name: "receipts", parentId: finance.id }), "categories.duplicate_name");
    await expect(tags.createCategory({ userId, name: "Receipts" })).resolves.toMatchObject({ name: "Receipts", parentId: null });
  });

  it("rejects a duplicate root category name that differs only by case", async () => {
    // Regression coverage for a real gap found during planning: SQLite treats every
    // NULL as distinct in a UNIQUE index, so two root categories (parent_id null)
    // are not caught by the (user_id, parent_id, name) index alone. The partial
    // root-only unique index must catch this.
    await tags.createCategory({ userId, name: "Finance" });
    await expectAppError(() => tags.createCategory({ userId, name: "finance" }), "categories.duplicate_name");
  });

  it("rejects self-parenting and cycles when moving a category", async () => {
    const a = await tags.createCategory({ userId, name: "A" });
    const b = await tags.createCategory({ userId, name: "B", parentId: a.id });
    const c = await tags.createCategory({ userId, name: "C", parentId: b.id });
    await expectAppError(() => tags.updateCategory({ userId, categoryId: a.id, patch: { parentId: a.id } }), "categories.invalid_parent");
    await expectAppError(() => tags.updateCategory({ userId, categoryId: a.id, patch: { parentId: c.id } }), "categories.invalid_parent");
    await expectAppError(() => tags.updateCategory({ userId, categoryId: a.id, patch: { parentId: "cat_0000000000000000" } }), "categories.invalid_parent");
    const moved = await tags.updateCategory({ userId, categoryId: c.id, patch: { parentId: a.id } });
    expect(moved.parentId).toBe(a.id);
  });

  it("deleting a category moves its children up to its parent and clears it from every document, manual or automatic", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    const receipts = await tags.createCategory({ userId, name: "Receipts", parentId: tax.id });
    const manualDoc = documentFixture({ categoryId: tax.id, categorySource: "manual" });
    const autoDoc = documentFixture({ categoryId: tax.id, categorySource: "auto" });
    await documents.insert(manualDoc);
    await documents.insert(autoDoc);

    await tags.deleteCategory({ userId, categoryId: tax.id });

    const list = await tags.listCategories(userId);
    expect(list.find((c) => c.id === receipts.id)?.parentId).toBe(finance.id);
    expect(await documents.findById({ userId, documentId: manualDoc.id! as string })).toMatchObject({ categoryId: null, categorySource: null });
    expect(await documents.findById({ userId, documentId: autoDoc.id! as string })).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("deleting a root category moves its children to the root", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    await tags.deleteCategory({ userId, categoryId: finance.id });
    expect((await tags.listCategories(userId)).find((c) => c.id === tax.id)?.parentId).toBeNull();
  });

  it("turning autoApply off on a category clears only the auto-sourced documents", async () => {
    const category = await tags.createCategory({ userId, name: "Finance" });
    const manualDoc = documentFixture({ categoryId: category.id, categorySource: "manual" });
    const autoDoc = documentFixture({ categoryId: category.id, categorySource: "auto" });
    await documents.insert(manualDoc);
    await documents.insert(autoDoc);

    await tags.updateCategory({ userId, categoryId: category.id, patch: { autoApply: false } });

    expect(await documents.findById({ userId, documentId: manualDoc.id! as string })).toMatchObject({ categoryId: category.id, categorySource: "manual" });
    expect(await documents.findById({ userId, documentId: autoDoc.id! as string })).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("counts documents linked to a tag and removes the link (by cascade) when the tag is deleted", async () => {
    const tag = await tags.createTag({ userId, name: "Rent" });
    const doc = documentFixture();
    await documents.insert(doc);
    await tags.setDocumentTag({ userId, documentId: doc.id! as string, tagId: tag.id });
    expect((await tags.listTags(userId)).find((t) => t.id === tag.id)?.documentCount).toBe(1);

    await tags.deleteTag({ userId, tagId: tag.id });
    expect(await tagsRepository.listTagsForDocument(doc.id! as string)).toEqual([]);
  });

  it("deleting a document cascades to its document_tags rows", async () => {
    // Regression coverage for review finding B1: without ON DELETE CASCADE, deleting a
    // document would leave an orphan document_tags row inflating the tag's count.
    const tag = await tags.createTag({ userId, name: "Rent" });
    const doc = documentFixture();
    await documents.insert(doc);
    await tags.setDocumentTag({ userId, documentId: doc.id, tagId: tag.id });
    expect((await tags.listTags(userId)).find((t) => t.id === tag.id)?.documentCount).toBe(1);

    await documents.remove({ userId, documentId: doc.id });

    expect(await tagsRepository.listTagsForDocument(doc.id)).toEqual([]);
    expect((await tags.listTags(userId)).find((t) => t.id === tag.id)?.documentCount).toBe(0);
  });

  it("sets and clears a document's manual category, rejecting an unknown category", async () => {
    const doc = documentFixture();
    await documents.insert(doc);
    const category = await tags.createCategory({ userId, name: "Finance" });

    const withCategory = await tags.setDocumentCategory({ userId, documentId: doc.id! as string, categoryId: category.id });
    expect(withCategory).toMatchObject({ categoryId: category.id, categorySource: "manual" });

    const cleared = await tags.setDocumentCategory({ userId, documentId: doc.id! as string, categoryId: null });
    expect(cleared).toMatchObject({ categoryId: null, categorySource: null });

    await expectAppError(
      () => tags.setDocumentCategory({ userId, documentId: doc.id! as string, categoryId: "cat_0000000000000000" }),
      "categories.not_found",
    );
    await expectAppError(
      () => tags.setDocumentCategory({ userId, documentId: "doc_0000000000000000", categoryId: null }),
      "documents.not_found",
    );
  });

  it("sets and clears a document's manual tag, deleting the link only when nothing else applies it", async () => {
    const doc = documentFixture();
    await documents.insert(doc);
    const tag = await tags.createTag({ userId, name: "Rent" });

    const withTag = await tags.setDocumentTag({ userId, documentId: doc.id! as string, tagId: tag.id });
    expect(withTag).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);

    const cleared = await tags.clearDocumentTag({ userId, documentId: doc.id! as string, tagId: tag.id });
    expect(cleared).toEqual([]);

    await expectAppError(() => tags.setDocumentTag({ userId, documentId: doc.id! as string, tagId: "tag_0000000000000000" }), "tags.not_found");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- tags.usecases`
Expected: FAIL, cannot find module `./tags.usecases.js`.

- [ ] **Step 3: Write the repository**

`apps/server/src/modules/tags/tags.repository.ts`:
```ts
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "../documents/documents.tables.js";
import { categoriesTable, documentTagsTable, tagsTable } from "./tags.tables.js";
import type { Category, DocumentTag, NewCategory, NewTag, Tag, TagChip } from "./tags.types.js";

export function createTagsRepository({ db }: { db: Database }) {
  return {
    async insertTag(tag: NewTag) {
      await db.insert(tagsTable).values(tag);
    },
    async findTagById({ userId, tagId }: { userId: string; tagId: string }): Promise<Tag | null> {
      const [row] = await db.select().from(tagsTable).where(and(eq(tagsTable.userId, userId), eq(tagsTable.id, tagId)));
      return row ?? null;
    },
    async listTagsRaw(userId: string): Promise<Tag[]> {
      return db.select().from(tagsTable).where(eq(tagsTable.userId, userId));
    },
    async countDocumentsByTag(userId: string): Promise<Map<string, number>> {
      const rows = await db
        .select({ tagId: documentTagsTable.tagId, count: sql<number>`count(*)` })
        .from(documentTagsTable)
        .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
        .where(eq(tagsTable.userId, userId))
        .groupBy(documentTagsTable.tagId);
      return new Map(rows.map((r) => [r.tagId, Number(r.count)]));
    },
    async updateTag({ userId, tagId, patch }: { userId: string; tagId: string; patch: Partial<NewTag> }) {
      await db.update(tagsTable).set(patch).where(and(eq(tagsTable.userId, userId), eq(tagsTable.id, tagId)));
    },
    async deleteTag({ userId, tagId }: { userId: string; tagId: string }) {
      await db.delete(tagsTable).where(and(eq(tagsTable.userId, userId), eq(tagsTable.id, tagId)));
    },

    async insertCategory(category: NewCategory) {
      await db.insert(categoriesTable).values(category);
    },
    async findCategoryById({ userId, categoryId }: { userId: string; categoryId: string }): Promise<Category | null> {
      const [row] = await db.select().from(categoriesTable).where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.id, categoryId)));
      return row ?? null;
    },
    async listCategoriesRaw(userId: string): Promise<Category[]> {
      return db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
    },
    async countDocumentsByCategory(userId: string): Promise<Map<string, number>> {
      const rows = await db
        .select({ categoryId: documentsTable.categoryId, count: sql<number>`count(*)` })
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), isNotNull(documentsTable.categoryId)))
        .groupBy(documentsTable.categoryId);
      return new Map(rows.map((r) => [r.categoryId as string, Number(r.count)]));
    },
    async updateCategory({ userId, categoryId, patch }: { userId: string; categoryId: string; patch: Partial<NewCategory> }) {
      await db.update(categoriesTable).set(patch).where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.id, categoryId)));
    },
    async deleteCategory({ userId, categoryId, tx = db }: { userId: string; categoryId: string; tx?: Database }) {
      await tx.delete(categoriesTable).where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.id, categoryId)));
    },
    async reparentChildren({
      userId,
      oldParentId,
      newParentId,
      tx = db,
    }: {
      userId: string;
      oldParentId: string;
      newParentId: string | null;
      tx?: Database;
    }) {
      await tx
        .update(categoriesTable)
        .set({ parentId: newParentId })
        .where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.parentId, oldParentId)));
    },
    async clearCategoryOnDocuments({ userId, categoryId, tx = db }: { userId: string; categoryId: string; tx?: Database }) {
      await tx
        .update(documentsTable)
        .set({ categoryId: null, categorySource: null })
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.categoryId, categoryId)));
    },
    async clearAutoCategoryOnDocuments({ userId, categoryId }: { userId: string; categoryId: string }) {
      await db
        .update(documentsTable)
        .set({ categoryId: null, categorySource: null })
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.categoryId, categoryId), eq(documentsTable.categorySource, "auto")));
    },

    async findDocumentTag({ documentId, tagId }: { documentId: string; tagId: string }): Promise<DocumentTag | null> {
      const [row] = await db
        .select()
        .from(documentTagsTable)
        .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
      return row ?? null;
    },
    async upsertDocumentTagManual({ documentId, tagId, manual }: { documentId: string; tagId: string; manual: boolean }) {
      const existing = await this.findDocumentTag({ documentId, tagId });
      if (!existing) {
        if (!manual) return;
        await db.insert(documentTagsTable).values({ documentId, tagId, appliedByManual: 1, appliedByAuto: 0 });
        return;
      }
      const appliedByManual = manual ? 1 : 0;
      if (appliedByManual === 0 && existing.appliedByAuto === 0) {
        await db.delete(documentTagsTable).where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
        return;
      }
      await db
        .update(documentTagsTable)
        .set({ appliedByManual })
        .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
    },
    async listTagsForDocument(documentId: string): Promise<TagChip[]> {
      const rows = await db
        .select({
          id: tagsTable.id,
          name: tagsTable.name,
          color: tagsTable.color,
          appliedByAuto: documentTagsTable.appliedByAuto,
          appliedByManual: documentTagsTable.appliedByManual,
        })
        .from(documentTagsTable)
        .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
        .where(eq(documentTagsTable.documentId, documentId));
      return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, auto: r.appliedByAuto === 1, manual: r.appliedByManual === 1 }));
    },
    async listTagsForDocuments(documentIds: string[]): Promise<Map<string, TagChip[]>> {
      const map = new Map<string, TagChip[]>();
      if (documentIds.length === 0) return map;
      const rows = await db
        .select({
          documentId: documentTagsTable.documentId,
          id: tagsTable.id,
          name: tagsTable.name,
          color: tagsTable.color,
          appliedByAuto: documentTagsTable.appliedByAuto,
          appliedByManual: documentTagsTable.appliedByManual,
        })
        .from(documentTagsTable)
        .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
        .where(inArray(documentTagsTable.documentId, documentIds));
      for (const r of rows) {
        const chip: TagChip = { id: r.id, name: r.name, color: r.color, auto: r.appliedByAuto === 1, manual: r.appliedByManual === 1 };
        const list = map.get(r.documentId) ?? [];
        list.push(chip);
        map.set(r.documentId, list);
      }
      return map;
    },
  };
}

export type TagsRepository = ReturnType<typeof createTagsRepository>;
```

Note: `upsertDocumentTagManual` calls `this.findDocumentTag`, which requires the object literal's methods to be called through the returned object (`repository.upsertDocumentTagManual(...)`), not destructured. This matches how every other repository in the codebase is consumed (`createDocumentsRepository({ db })` is always used as `repository.method(...)`, never destructured).

- [ ] **Step 4: Write the usecases**

`apps/server/src/modules/tags/tags.usecases.ts`:
```ts
import { LibsqlError } from "@libsql/client";
import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import {
  buildCategoryPaths,
  newCategoryId,
  newTagId,
  nextSortOrder,
  normalizeName,
  nowIso,
  sortByNameCI,
  sortCategories,
  wouldCreateCycle,
} from "./tags.models.js";
import { createTagsRepository } from "./tags.repository.js";
import type { Category, CategoryWithMeta, NewCategory, NewTag, Tag, TagChip, TagWithCount } from "./tags.types.js";

function isUniqueConstraintError(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof LibsqlError && cause.code === "SQLITE_CONSTRAINT";
}

function tagNotFound(tagId: string) {
  return createError({ code: "tags.not_found", message: `Tag "${tagId}" not found`, status: 404 });
}
function tagDuplicateName() {
  return createError({ code: "tags.duplicate_name", message: "A tag with this name already exists", status: 409 });
}
function categoryNotFound(categoryId: string) {
  return createError({ code: "categories.not_found", message: `Category "${categoryId}" not found`, status: 404 });
}
function categoryDuplicateName() {
  return createError({ code: "categories.duplicate_name", message: "A category with this name already exists under the same parent", status: 409 });
}
function categoryInvalidParent() {
  return createError({ code: "categories.invalid_parent", message: "That parent category is not valid", status: 400 });
}
function documentNotFound(documentId: string) {
  return createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
}

type TagPatch = { name?: string; color?: string | null; description?: string; confidenceThreshold?: number; autoApply?: boolean };
type CategoryPatch = TagPatch & { parentId?: string | null; sortOrder?: number };

export function createTagsService({ db }: { db: Database }) {
  const repository = createTagsRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });

  async function getTagOrThrow(userId: string, tagId: string): Promise<Tag> {
    const tag = await repository.findTagById({ userId, tagId });
    if (!tag) throw tagNotFound(tagId);
    return tag;
  }

  async function getCategoryOrThrow(userId: string, categoryId: string): Promise<Category> {
    const category = await repository.findCategoryById({ userId, categoryId });
    if (!category) throw categoryNotFound(categoryId);
    return category;
  }

  async function ensureDocumentExists(userId: string, documentId: string) {
    const document = await documentsRepository.findById({ userId, documentId });
    if (!document) throw documentNotFound(documentId);
    return document;
  }

  // autoApply is an integer 0/1 column (see decision 27). These two helpers are the
  // only places a Tag or Category becomes client-facing, so they are the only places
  // that need to convert it to a real boolean.
  function presentTag(tag: Tag, documentCount: number): TagWithCount {
    return { ...tag, autoApply: tag.autoApply === 1, documentCount };
  }

  function presentCategory(category: Category, path: string, documentCount: number): CategoryWithMeta {
    return { ...category, autoApply: category.autoApply === 1, path, documentCount };
  }

  async function withTagCounts(userId: string, tags: Tag[]): Promise<TagWithCount[]> {
    const counts = await repository.countDocumentsByTag(userId);
    return sortByNameCI(tags).map((t) => presentTag(t, counts.get(t.id) ?? 0));
  }

  async function withCategoryMeta(userId: string, categories: Category[]): Promise<CategoryWithMeta[]> {
    const [counts, paths] = await Promise.all([repository.countDocumentsByCategory(userId), Promise.resolve(buildCategoryPaths(categories))]);
    return sortCategories(categories).map((c) => presentCategory(c, paths.get(c.id) ?? c.name, counts.get(c.id) ?? 0));
  }

  return {
    async listTags(userId: string) {
      return withTagCounts(userId, await repository.listTagsRaw(userId));
    },

    async createTag({
      userId,
      name,
      color = null,
      description = "",
      confidenceThreshold = 0.7,
      autoApply = true,
    }: {
      userId: string;
      name: string;
      color?: string | null;
      description?: string;
      confidenceThreshold?: number;
      autoApply?: boolean;
    }): Promise<TagWithCount> {
      const id = newTagId();
      const t = nowIso();
      const tag: NewTag = {
        id,
        userId,
        name: normalizeName(name),
        color,
        description,
        confidenceThreshold,
        autoApply: autoApply ? 1 : 0,
        createdAt: t,
        updatedAt: t,
      };
      try {
        await repository.insertTag(tag);
      } catch (error) {
        if (isUniqueConstraintError(error)) throw tagDuplicateName();
        throw error;
      }
      return presentTag(await getTagOrThrow(userId, id), 0);
    },

    async updateTag({ userId, tagId, patch }: { userId: string; tagId: string; patch: TagPatch }): Promise<TagWithCount> {
      await getTagOrThrow(userId, tagId);
      const dbPatch: Partial<NewTag> = { updatedAt: nowIso() };
      if (patch.name !== undefined) dbPatch.name = normalizeName(patch.name);
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.confidenceThreshold !== undefined) dbPatch.confidenceThreshold = patch.confidenceThreshold;
      if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
      try {
        await repository.updateTag({ userId, tagId, patch: dbPatch });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw tagDuplicateName();
        throw error;
      }
      const counts = await repository.countDocumentsByTag(userId);
      return presentTag(await getTagOrThrow(userId, tagId), counts.get(tagId) ?? 0);
    },

    async deleteTag({ userId, tagId }: { userId: string; tagId: string }) {
      await getTagOrThrow(userId, tagId);
      await repository.deleteTag({ userId, tagId });
    },

    async listCategories(userId: string) {
      return withCategoryMeta(userId, await repository.listCategoriesRaw(userId));
    },

    async createCategory({
      userId,
      name,
      parentId = null,
      color = null,
      description = "",
      confidenceThreshold = 0.7,
      autoApply = true,
    }: {
      userId: string;
      name: string;
      parentId?: string | null;
      color?: string | null;
      description?: string;
      confidenceThreshold?: number;
      autoApply?: boolean;
    }): Promise<CategoryWithMeta> {
      if (parentId !== null) await getCategoryOrThrow(userId, parentId);
      const siblings = (await repository.listCategoriesRaw(userId)).filter((c) => c.parentId === parentId);
      const id = newCategoryId();
      const t = nowIso();
      const category: NewCategory = {
        id,
        userId,
        name: normalizeName(name),
        parentId,
        color,
        description,
        confidenceThreshold,
        autoApply: autoApply ? 1 : 0,
        sortOrder: nextSortOrder(siblings.map((s) => s.sortOrder)),
        createdAt: t,
        updatedAt: t,
      };
      try {
        await repository.insertCategory(category);
      } catch (error) {
        if (isUniqueConstraintError(error)) throw categoryDuplicateName();
        throw error;
      }
      return presentCategory(await getCategoryOrThrow(userId, id), category.name, 0);
    },

    async updateCategory({ userId, categoryId, patch }: { userId: string; categoryId: string; patch: CategoryPatch }): Promise<CategoryWithMeta> {
      const existing = await getCategoryOrThrow(userId, categoryId);
      if (patch.parentId !== undefined && patch.parentId !== existing.parentId) {
        if (patch.parentId !== null) {
          const all = await repository.listCategoriesRaw(userId);
          const parentExists = all.some((c) => c.id === patch.parentId);
          if (!parentExists || wouldCreateCycle(all, categoryId, patch.parentId)) throw categoryInvalidParent();
        }
      }
      const dbPatch: Partial<NewCategory> = { updatedAt: nowIso() };
      if (patch.name !== undefined) dbPatch.name = normalizeName(patch.name);
      if (patch.parentId !== undefined) dbPatch.parentId = patch.parentId;
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.confidenceThreshold !== undefined) dbPatch.confidenceThreshold = patch.confidenceThreshold;
      if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
      if (patch.sortOrder !== undefined) dbPatch.sortOrder = patch.sortOrder;
      try {
        await repository.updateCategory({ userId, categoryId, patch: dbPatch });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw categoryDuplicateName();
        throw error;
      }
      if (patch.autoApply === false && existing.autoApply === 1) {
        await repository.clearAutoCategoryOnDocuments({ userId, categoryId });
      }
      const counts = await repository.countDocumentsByCategory(userId);
      const paths = buildCategoryPaths(await repository.listCategoriesRaw(userId));
      const updated = await getCategoryOrThrow(userId, categoryId);
      return presentCategory(updated, paths.get(categoryId) ?? updated.name, counts.get(categoryId) ?? 0);
    },

    async deleteCategory({ userId, categoryId }: { userId: string; categoryId: string }) {
      const category = await getCategoryOrThrow(userId, categoryId);
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        await repository.reparentChildren({ userId, oldParentId: categoryId, newParentId: category.parentId, tx: txDb });
        await repository.clearCategoryOnDocuments({ userId, categoryId, tx: txDb });
        await repository.deleteCategory({ userId, categoryId, tx: txDb });
      });
    },

    async setDocumentCategory({
      userId,
      documentId,
      categoryId,
    }: {
      userId: string;
      documentId: string;
      categoryId: string | null;
    }) {
      await ensureDocumentExists(userId, documentId);
      if (categoryId !== null) await getCategoryOrThrow(userId, categoryId);
      await documentsRepository.update({
        userId,
        documentId,
        patch: { categoryId, categorySource: categoryId === null ? null : "manual", updatedAt: nowIso() },
      });
      return documentsRepository.findById({ userId, documentId });
    },

    async setDocumentTag({ userId, documentId, tagId }: { userId: string; documentId: string; tagId: string }): Promise<TagChip[]> {
      await ensureDocumentExists(userId, documentId);
      await getTagOrThrow(userId, tagId);
      await repository.upsertDocumentTagManual({ documentId, tagId, manual: true });
      return repository.listTagsForDocument(documentId);
    },

    async clearDocumentTag({ userId, documentId, tagId }: { userId: string; documentId: string; tagId: string }): Promise<TagChip[]> {
      await ensureDocumentExists(userId, documentId);
      await repository.upsertDocumentTagManual({ documentId, tagId, manual: false });
      return repository.listTagsForDocument(documentId);
    },
  };
}

export type TagsService = ReturnType<typeof createTagsService>;
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @docmind/server test -- tags.usecases`
Expected: PASS, every `it` block green.

- [ ] **Step 6: Run the full server test suite**

Run: `pnpm --filter @docmind/server test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/tags/tags.repository.ts \
        apps/server/src/modules/tags/tags.usecases.ts \
        apps/server/src/modules/tags/tags.usecases.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add tags and categories CRUD with document assignment

Adds createTagsService covering tag and category CRUD, sibling
uniqueness, cycle-safe reparenting, cascading deletes that move
children up and clear documents, and manual category and tag
assignment on documents.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 3: Routes for tags, categories, and document assignment

**Files:**
- Create: `apps/server/src/modules/tags/tags.schemas.ts`, `tags.routes.ts`, `tags.routes.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Consumes: `TagsService` from `tags.usecases.ts`; `documentIdSchema` from `../documents/documents.schemas.js`; `parseJsonBody`, `parseOrValidationError` from `../../shared/http/validate.js`.
- Produces: `tagIdSchema`, `categoryIdSchema`, `createTagBodySchema`, `updateTagBodySchema`, `createCategoryBodySchema`, `updateCategoryBodySchema`, `documentCategoryBodySchema` from `tags.schemas.ts`, consumed by Task 4's `documents.schemas.ts`. `registerTagsRoutes({ app, tagsService, getUserId })`, consumed by `server.ts`. Routes: `GET/POST /api/tags`, `PATCH/DELETE /api/tags/:id`, `GET/POST /api/categories`, `PATCH/DELETE /api/categories/:id`, `PUT /api/documents/:id/category`, `POST/DELETE /api/documents/:id/tags/:tagId`.

- [ ] **Step 1: Write the failing route tests**

`apps/server/src/modules/tags/tags.routes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

describe("tags and categories routes", () => {
  it("requires a session on every route", async () => {
    const { app } = await createTestApp();
    expect((await app.request("/api/tags")).status).toBe(401);
    expect((await app.request("/api/categories")).status).toBe(401);
  });

  it("creates, lists, updates, and deletes a tag over HTTP", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();

    const created = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rent", color: "#4f46e5" }),
    });
    expect(created.status).toBe(201);
    const { tag } = await created.json();
    expect(tag).toMatchObject({ name: "Rent", color: "#4f46e5", autoApply: true, confidenceThreshold: 0.7, documentCount: 0 });

    const list = await (await app.request("/api/tags", { headers: { cookie } })).json();
    expect(list.tags.map((t: { id: string }) => t.id)).toEqual([tag.id]);

    const updated = await app.request(`/api/tags/${tag.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: "Monthly rent payments" }),
    });
    expect((await updated.json()).tag.description).toBe("Monthly rent payments");

    expect((await app.request(`/api/tags/${tag.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await (await app.request("/api/tags", { headers: { cookie } })).json()).tags).toEqual([]);
  });

  it("rejects an invalid tag body and a duplicate name", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const empty = await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "" }) });
    expect(empty.status).toBe(400);
    await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Rent" }) });
    const dup = await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "rent" }) });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("tags.duplicate_name");
  });

  it("creates nested categories, moves one, and rejects a cycle", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();

    const finance = await (
      await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Finance" }) })
    ).json();
    const tax = await (
      await app.request("/api/categories", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Tax", parentId: finance.category.id }),
      })
    ).json();
    expect(tax.category.path).toBe("Finance / Tax");

    const cycle = await app.request(`/api/categories/${finance.category.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ parentId: tax.category.id }),
    });
    expect(cycle.status).toBe(400);
    expect((await cycle.json()).error.code).toBe("categories.invalid_parent");

    const list = await (await app.request("/api/categories", { headers: { cookie } })).json();
    expect(list.categories.map((c: { id: string }) => c.id).sort()).toEqual([finance.category.id, tax.category.id].sort());

    expect((await app.request(`/api/categories/${tax.category.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
  });

  it("sets and clears a document's category and tags, scoped by user", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    const { document } = await services.documentsService.upload({ userId, name: "a.txt", mimeType: "text/plain", body: (await import("node:stream")).Readable.from(["a"]) });
    const category = (
      await (
        await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Finance" }) })
      ).json()
    ).category;
    const tag = (
      await (await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Rent" }) })).json()
    ).tag;

    const setCategory = await app.request(`/api/documents/${document.id}/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: category.id }),
    });
    expect((await setCategory.json()).document).toMatchObject({ categoryId: category.id, categorySource: "manual" });

    const addTag = await app.request(`/api/documents/${document.id}/tags/${tag.id}`, { method: "POST", headers: { cookie } });
    expect((await addTag.json()).tags).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);

    const removeTag = await app.request(`/api/documents/${document.id}/tags/${tag.id}`, { method: "DELETE", headers: { cookie } });
    expect((await removeTag.json()).tags).toEqual([]);

    const clearCategory = await app.request(`/api/documents/${document.id}/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    expect((await clearCategory.json()).document).toMatchObject({ categoryId: null, categorySource: null });

    const otherUserCookie = (await signIn("other@example.com")).cookie;
    const forbidden = await app.request(`/api/documents/${document.id}/category`, {
      method: "PUT",
      headers: { cookie: otherUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    expect(forbidden.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- tags.routes`
Expected: FAIL, cannot find module `./tags.routes.js`.

- [ ] **Step 3: Write the schemas**

`apps/server/src/modules/tags/tags.schemas.ts`:
```ts
import * as v from "valibot";

export const tagIdSchema = v.pipe(v.string(), v.regex(/^tag_[0-9a-f]{16}$/));
export const categoryIdSchema = v.pipe(v.string(), v.regex(/^cat_[0-9a-f]{16}$/));

export const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60));
export const colorSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value like #4f46e5"));
export const tagDescriptionSchema = v.pipe(v.string(), v.maxLength(300));
export const categoryDescriptionSchema = v.pipe(v.string(), v.maxLength(2000));
export const thresholdSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const nullableColor = v.nullable(colorSchema);

export const createTagBodySchema = v.object({
  name: nameSchema,
  color: v.optional(nullableColor, null),
  description: v.optional(tagDescriptionSchema, ""),
  confidenceThreshold: v.optional(thresholdSchema, 0.7),
  autoApply: v.optional(v.boolean(), true),
});

export const updateTagBodySchema = v.object({
  name: v.optional(nameSchema),
  color: v.optional(nullableColor),
  description: v.optional(tagDescriptionSchema),
  confidenceThreshold: v.optional(thresholdSchema),
  autoApply: v.optional(v.boolean()),
});

export const createCategoryBodySchema = v.object({
  name: nameSchema,
  parentId: v.optional(v.nullable(categoryIdSchema), null),
  color: v.optional(nullableColor, null),
  description: v.optional(categoryDescriptionSchema, ""),
  confidenceThreshold: v.optional(thresholdSchema, 0.7),
  autoApply: v.optional(v.boolean(), true),
});

export const updateCategoryBodySchema = v.object({
  name: v.optional(nameSchema),
  parentId: v.optional(v.nullable(categoryIdSchema)),
  color: v.optional(nullableColor),
  description: v.optional(categoryDescriptionSchema),
  confidenceThreshold: v.optional(thresholdSchema),
  autoApply: v.optional(v.boolean()),
  sortOrder: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const documentCategoryBodySchema = v.object({
  categoryId: v.nullable(categoryIdSchema),
});
```

- [ ] **Step 4: Write the routes**

`apps/server/src/modules/tags/tags.routes.ts`:
```ts
import type { Context, Hono } from "hono";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import {
  categoryIdSchema,
  createCategoryBodySchema,
  createTagBodySchema,
  documentCategoryBodySchema,
  tagIdSchema,
  updateCategoryBodySchema,
  updateTagBodySchema,
} from "./tags.schemas.js";
import type { TagsService } from "./tags.usecases.js";

export function registerTagsRoutes({
  app,
  tagsService,
  getUserId,
}: {
  app: Hono;
  tagsService: TagsService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/tags", async (c) => {
    const tags = await tagsService.listTags(getUserId(c));
    return c.json({ tags });
  });

  app.post("/api/tags", async (c) => {
    const body = await parseJsonBody(c, createTagBodySchema);
    const tag = await tagsService.createTag({ userId: getUserId(c), ...body });
    return c.json({ tag }, 201);
  });

  app.patch("/api/tags/:id", async (c) => {
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("id"));
    const patch = await parseJsonBody(c, updateTagBodySchema);
    const tag = await tagsService.updateTag({ userId: getUserId(c), tagId, patch });
    return c.json({ tag });
  });

  app.delete("/api/tags/:id", async (c) => {
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("id"));
    await tagsService.deleteTag({ userId: getUserId(c), tagId });
    return c.body(null, 204);
  });

  app.get("/api/categories", async (c) => {
    const categories = await tagsService.listCategories(getUserId(c));
    return c.json({ categories });
  });

  app.post("/api/categories", async (c) => {
    const body = await parseJsonBody(c, createCategoryBodySchema);
    const category = await tagsService.createCategory({ userId: getUserId(c), ...body });
    return c.json({ category }, 201);
  });

  app.patch("/api/categories/:id", async (c) => {
    const categoryId = parseOrValidationError(categoryIdSchema, c.req.param("id"));
    const patch = await parseJsonBody(c, updateCategoryBodySchema);
    const category = await tagsService.updateCategory({ userId: getUserId(c), categoryId, patch });
    return c.json({ category });
  });

  app.delete("/api/categories/:id", async (c) => {
    const categoryId = parseOrValidationError(categoryIdSchema, c.req.param("id"));
    await tagsService.deleteCategory({ userId: getUserId(c), categoryId });
    return c.body(null, 204);
  });

  app.put("/api/documents/:id/category", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const { categoryId } = await parseJsonBody(c, documentCategoryBodySchema);
    const document = await tagsService.setDocumentCategory({ userId: getUserId(c), documentId, categoryId });
    return c.json({ document });
  });

  app.post("/api/documents/:id/tags/:tagId", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("tagId"));
    const tags = await tagsService.setDocumentTag({ userId: getUserId(c), documentId, tagId });
    return c.json({ tags });
  });

  app.delete("/api/documents/:id/tags/:tagId", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const tagId = parseOrValidationError(tagIdSchema, c.req.param("tagId"));
    const tags = await tagsService.clearDocumentTag({ userId: getUserId(c), documentId, tagId });
    return c.json({ tags });
  });
}
```

- [ ] **Step 5: Wire the module into `server.ts`**

Add imports near the other module imports:
```ts
import { registerTagsRoutes } from "./modules/tags/tags.routes.js";
import { createTagsService } from "./modules/tags/tags.usecases.js";
```

After `const documentsService = createDocumentsService({ ... });` add:
```ts
const tagsService = createTagsService({ db });
```

After `registerDocumentsRoutes({ app, documentsService, getUserId });` add:
```ts
registerTagsRoutes({ app, tagsService, getUserId });
```

Add `tagsService` to the object returned by `createServer`:
```ts
return { app, auth, settingsService, storageService, documentsService, jobsService, extractionService, jobRunner, ocrEngine, aiService, tagsService, getUserId };
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @docmind/server test -- tags.routes`
Expected: PASS.

- [ ] **Step 7: Run the full server test suite**

Run: `pnpm --filter @docmind/server test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/tags/tags.schemas.ts \
        apps/server/src/modules/tags/tags.routes.ts \
        apps/server/src/modules/tags/tags.routes.test.ts \
        apps/server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): add tags, categories, and document assignment routes

Registers GET/POST /api/tags, PATCH/DELETE /api/tags/:id, the same
shape for /api/categories, PUT /api/documents/:id/category, and
POST/DELETE /api/documents/:id/tags/:tagId, wired into the server
alongside the existing document routes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 4: Documents list filters, enrichment, and the storage key layout change

**Files:**
- Modify: `apps/server/src/modules/storage/storage.usecases.ts`, `storage.usecases.test.ts`
- Modify: `apps/server/src/modules/documents/documents.types.ts`, `documents.repository.ts`, `documents.usecases.ts`, `documents.usecases.test.ts`, `documents.schemas.ts`, `documents.routes.ts`, `documents.routes.test.ts`
- Modify: `apps/server/src/modules/extraction/extraction.usecases.ts`, `extraction.usecases.test.ts`

**Interfaces:**
- Consumes: `categoriesTable`, `tagsTable`, `documentTagsTable` from `../tags/tags.tables.js`; `buildCategoryPaths`, `collectDescendantIds` from `../tags/tags.models.js`; `TagChip` from `../tags/tags.types.js`; `categoryIdSchema`, `tagIdSchema` from `../tags/tags.schemas.js`; `createTagsService` from `../tags/tags.usecases.js` (tests only).
- Produces: `buildStorageKey({ userId, documentId, filename, uploadedAt })` (signature change, consumed only by `documents.usecases.ts`). `documentsService.list({ userId, categoryId?, tagId?, view? })` and `documentsService.get({ userId, documentId })` (now returns `categoryPath`/`tags` too), consumed by Task 5's client and Task 7. `DocumentView = "inbox" | "needs_review" | "all"`. `GET /api/documents` query params `categoryId`, `tagId`, `view`.

- [ ] **Step 1: Write the failing storage key tests**

Replace the two `buildStorageKey` tests in `apps/server/src/modules/storage/storage.usecases.test.ts` (keep the rest of the file, including the `createStorageService` tests, unchanged):
```ts
it("builds a safe key with the upload year and month from the given date, in UTC", () => {
  const uploadedAt = new Date("2026-03-05T12:00:00.000Z");
  expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "My Report (final).pdf", uploadedAt })).toBe(
    "u1/2026/03/d1/My_Report_final_.pdf",
  );
  expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "../../x", uploadedAt })).toBe("u1/2026/03/d1/x");
});

it("pads a single-digit month", () => {
  const uploadedAt = new Date("2026-01-09T23:30:00.000Z");
  expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "a.txt", uploadedAt })).toBe("u1/2026/01/d1/a.txt");
});
```

- [ ] **Step 2: Run the storage tests to see them fail**

Run: `pnpm --filter @docmind/server test -- storage.usecases`
Expected: FAIL, `buildStorageKey` called without a required `uploadedAt`, or the old assertions no longer match.

- [ ] **Step 3: Update `buildStorageKey`**

In `apps/server/src/modules/storage/storage.usecases.ts`, replace the function:
```ts
export function buildStorageKey({
  userId,
  documentId,
  filename,
  uploadedAt,
}: {
  userId: string;
  documentId: string;
  filename: string;
  uploadedAt: Date;
}) {
  const base = basename(filename.replace(/\\/g, "/"));
  const safe = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
  const yyyy = uploadedAt.getUTCFullYear();
  const mm = String(uploadedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${userId}/${yyyy}/${mm}/${documentId}/${safe}`;
}
```

- [ ] **Step 4: Update the call site in `documents.usecases.ts`**

In `apps/server/src/modules/documents/documents.usecases.ts`'s `upload()`, compute one `Date` up front and reuse it for both the key and the row's timestamps:
```ts
async upload({
  userId,
  name,
  mimeType,
  body,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
}: {
  userId: string;
  name: string;
  mimeType?: string;
  body: Readable;
  maxUploadBytes?: number;
}) {
  const documentId = newDocumentId();
  const safeName = sanitizeFilename(name);
  const uploadedAt = new Date();
  const driverId = await storageService.getActiveDriverId(userId);
  const driver = await storageService.getDriver(userId, driverId);
  const key = buildStorageKey({ userId, documentId, filename: safeName, uploadedAt });

  const counter = hashingCounter();
  const toStorage = new PassThrough();
  const [, stored] = await Promise.all([
    pipeline(body, counter.transform, toStorage),
    driver.put({ key, body: toStorage, mimeType }),
  ]);
  const { sha256, sizeBytes } = counter.result();

  if (sizeBytes > maxUploadBytes) {
    await driver.delete({ key: stored.key });
    throw createError({ code: "documents.too_large", message: `Uploads are limited to ${maxUploadBytes} bytes`, status: 413 });
  }

  const existing = await repository.findByHash({ userId, contentHash: sha256 });
  if (existing) {
    await driver.delete({ key: stored.key });
    return { document: existing, duplicateOf: existing.id };
  }

  const timestamp = uploadedAt.toISOString();
  const document: Document = {
    id: documentId,
    userId,
    name: safeName,
    mimeType: mimeType ?? null,
    sizeBytes,
    contentHash: sha256,
    storageDriver: driverId,
    storageKey: stored.key,
    extractedText: null,
    extractionStatus: "pending",
    extractionError: null,
    ruleStatus: "pending",
    ruleError: null,
    embeddingStatus: "pending",
    embeddingError: null,
    categoryId: null,
    categorySource: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db.transaction(async (tx) => {
    await repository.insert(document, tx as unknown as Database);
    if (onUploaded) await onUploaded({ userId, document, tx: tx as unknown as Database });
  });
  return { document };
},
```

- [ ] **Step 5: Update the existing storage-key assertion and add a legacy-key regression test in `documents.usecases.test.ts`**

Replace this line in the "uploads, stores, and reads back a file" test:
```ts
expect(document.storageKey).toBe(`${userId}/${document.id}/notes.txt`);
```
with:
```ts
const now = new Date();
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
expect(document.storageKey).toBe(`${userId}/${yyyy}/${mm}/${document.id}/notes.txt`);
```

Hoist `storageService` and the raw `db` to the outer scope so later tests can reach the driver and a repository directly:
```ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createTagsService } from "../tags/tags.usecases.js";
import { createDocumentsRepository } from "./documents.repository.js";
import { createDocumentsService } from "./documents.usecases.js";

let root: string;
let documents: ReturnType<typeof createDocumentsService>;
let storageService: ReturnType<typeof createStorageService>;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const userId = "user-1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-docs-"));
  ({ db } = await createTestDatabase());
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(storageSettingDefinitions),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  storageService = createStorageService({ settingsService });
  documents = createDocumentsService({ db, storageService });
});
afterEach(() => rm(root, { recursive: true, force: true }));
```

Add a new test in the existing `describe("documents service", ...)` block proving the layout change does not break a file already on disk under the old layout:
```ts
it("still serves a file whose storage key uses the pre-C2 layout", async () => {
  const driver = await storageService.getDriver(userId, "local");
  const oldKey = `${userId}/doc_legacy00000000/old.txt`;
  await driver.put({ key: oldKey, body: Readable.from(["legacy content"]) });

  const repository = createDocumentsRepository({ db });
  const t = new Date().toISOString();
  await repository.insert({
    id: "doc_legacy00000000",
    userId,
    name: "old.txt",
    mimeType: "text/plain",
    sizeBytes: 14,
    contentHash: "legacyhash",
    storageDriver: "local",
    storageKey: oldKey,
    extractedText: null,
    extractionStatus: "done",
    extractionError: null,
    ruleStatus: "done",
    ruleError: null,
    embeddingStatus: "pending",
    embeddingError: null,
    categoryId: null,
    categorySource: null,
    createdAt: t,
    updatedAt: t,
  });

  const { stream } = await documents.openFile({ userId, documentId: "doc_legacy00000000" });
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  expect(Buffer.concat(chunks).toString()).toBe("legacy content");
});
```

- [ ] **Step 6: Run the storage and documents tests**

Run: `pnpm --filter @docmind/server test -- storage.usecases documents.usecases`
Expected: PASS.

- [ ] **Step 7: Fix the extraction final-failure gap**

In `apps/server/src/modules/extraction/extraction.usecases.ts`, update the `catch` block inside `extractDocument` so a final-attempt extraction failure also fails `ruleStatus`, per spec section 5 and review ruling 8:
```ts
} catch (error) {
  const message = ((error as Error).message ?? String(error)).slice(0, 2000);
  await documents.update({
    userId,
    documentId,
    patch: {
      extractionStatus: isFinalAttempt ? "failed" : "pending",
      extractionError: message,
      ...(isFinalAttempt ? { ruleStatus: "failed" as const, ruleError: "Extraction failed" } : {}),
      updatedAt: now(),
    },
  });
  throw error;
}
```

Extend the existing "fails the document and the job when no extractor matches" test in `apps/server/src/modules/extraction/extraction.usecases.test.ts` to also assert the new fields, right after the existing final-failure assertions:
```ts
doc = await t.services.documentsService.get({ userId, documentId: document.id });
expect(doc.extractionStatus).toBe("failed");
expect(doc.ruleStatus).toBe("failed");
expect(doc.ruleError).toBe("Extraction failed");
[job] = await t.services.jobsService.list({ userId });
expect(job).toMatchObject({ status: "failed", attempts: 3 });
```

- [ ] **Step 8: Run the extraction tests**

Run: `pnpm --filter @docmind/server test -- extraction.usecases`
Expected: PASS.

- [ ] **Step 9: Extend `documents.types.ts`**

`apps/server/src/modules/documents/documents.types.ts`:
```ts
import type { TagChip } from "../tags/tags.types.js";
import type { documentsTable } from "./documents.tables.js";

export type Document = typeof documentsTable.$inferSelect;
export type NewDocument = typeof documentsTable.$inferInsert;
export type DocumentView = "inbox" | "needs_review" | "all";
export type DocumentListRow = Omit<Document, "extractedText"> & { categoryPath: string | null; tags: TagChip[] };
```

- [ ] **Step 10: Extend `documents.repository.ts`**

Replace the file:
```ts
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { buildCategoryPaths, collectDescendantIds } from "../tags/tags.models.js";
import { categoriesTable, documentTagsTable, tagsTable } from "../tags/tags.tables.js";
import type { TagChip } from "../tags/tags.types.js";
import { documentsTable } from "./documents.tables.js";
import type { Document, DocumentListRow, DocumentView, NewDocument } from "./documents.types.js";

const listColumns = {
  id: documentsTable.id,
  userId: documentsTable.userId,
  name: documentsTable.name,
  mimeType: documentsTable.mimeType,
  sizeBytes: documentsTable.sizeBytes,
  contentHash: documentsTable.contentHash,
  storageDriver: documentsTable.storageDriver,
  storageKey: documentsTable.storageKey,
  extractionStatus: documentsTable.extractionStatus,
  extractionError: documentsTable.extractionError,
  ruleStatus: documentsTable.ruleStatus,
  ruleError: documentsTable.ruleError,
  embeddingStatus: documentsTable.embeddingStatus,
  embeddingError: documentsTable.embeddingError,
  categoryId: documentsTable.categoryId,
  categorySource: documentsTable.categorySource,
  createdAt: documentsTable.createdAt,
  updatedAt: documentsTable.updatedAt,
};

export function createDocumentsRepository({ db }: { db: Database }) {
  async function loadCategoryPathMap(userId: string) {
    const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
    return buildCategoryPaths(categories);
  }

  async function loadTagsByDocument(documentIds: string[]): Promise<Map<string, TagChip[]>> {
    const map = new Map<string, TagChip[]>();
    if (documentIds.length === 0) return map;
    const rows = await db
      .select({
        documentId: documentTagsTable.documentId,
        id: tagsTable.id,
        name: tagsTable.name,
        color: tagsTable.color,
        appliedByAuto: documentTagsTable.appliedByAuto,
        appliedByManual: documentTagsTable.appliedByManual,
      })
      .from(documentTagsTable)
      .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
      .where(inArray(documentTagsTable.documentId, documentIds));
    for (const r of rows) {
      const chip: TagChip = { id: r.id, name: r.name, color: r.color, auto: r.appliedByAuto === 1, manual: r.appliedByManual === 1 };
      const list = map.get(r.documentId) ?? [];
      list.push(chip);
      map.set(r.documentId, list);
    }
    return map;
  }

  return {
    async insert(document: NewDocument, tx: Database = db) {
      await tx.insert(documentsTable).values(document);
    },

    async listByUser({
      userId,
      categoryId,
      tagId,
      view = "all",
    }: {
      userId: string;
      categoryId?: string;
      tagId?: string;
      view?: DocumentView;
    }): Promise<DocumentListRow[]> {
      const conditions = [eq(documentsTable.userId, userId)];
      if (view === "inbox") conditions.push(inArray(documentsTable.ruleStatus, ["pending", "processing"]));
      if (view === "needs_review") {
        conditions.push(eq(documentsTable.ruleStatus, "done"));
        conditions.push(isNull(documentsTable.categoryId));
      }
      if (categoryId) {
        const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
        const ids = [categoryId, ...collectDescendantIds(categories, categoryId)];
        conditions.push(inArray(documentsTable.categoryId, ids));
      }
      if (tagId) {
        const linked = await db.select({ documentId: documentTagsTable.documentId }).from(documentTagsTable).where(eq(documentTagsTable.tagId, tagId));
        const ids = linked.map((r) => r.documentId);
        conditions.push(inArray(documentsTable.id, ids.length > 0 ? ids : ["__none__"]));
      }

      const rows = await db
        .select(listColumns)
        .from(documentsTable)
        .where(and(...conditions))
        .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));

      const [pathMap, tagsMap] = await Promise.all([loadCategoryPathMap(userId), loadTagsByDocument(rows.map((r) => r.id))]);
      return rows.map((row) => ({
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        tags: tagsMap.get(row.id) ?? [],
      }));
    },

    async findById({ userId, documentId }: { userId: string; documentId: string }): Promise<Document | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      return row ?? null;
    },

    async findByIdWithExtras({
      userId,
      documentId,
    }: {
      userId: string;
      documentId: string;
    }): Promise<(Document & { categoryPath: string | null; tags: TagChip[] }) | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      if (!row) return null;
      const [pathMap, tagsMap] = await Promise.all([loadCategoryPathMap(userId), loadTagsByDocument([row.id])]);
      return { ...row, categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null, tags: tagsMap.get(row.id) ?? [] };
    },

    async findByHash({ userId, contentHash }: { userId: string; contentHash: string }): Promise<Document | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.contentHash, contentHash)));
      return row ?? null;
    },

    async update({
      userId,
      documentId,
      patch,
      tx = db,
    }: {
      userId: string;
      documentId: string;
      patch: Partial<NewDocument>;
      tx?: Database;
    }) {
      await tx
        .update(documentsTable)
        .set(patch)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },

    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      await db.delete(documentsTable).where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },
  };
}

export type DocumentsRepository = ReturnType<typeof createDocumentsRepository>;
```

- [ ] **Step 11: Extend `documents.usecases.ts`**

Change `list` and `get` (leave `upload`, `rename`, `remove`, `openFile`, and the internal `getOrThrow` untouched beyond Step 4's edit):
```ts
list({
  userId,
  categoryId,
  tagId,
  view,
}: {
  userId: string;
  categoryId?: string;
  tagId?: string;
  view?: DocumentView;
}): Promise<DocumentListRow[]> {
  return repository.listByUser({ userId, categoryId, tagId, view });
},

get({ userId, documentId }: { userId: string; documentId: string }) {
  return getEnrichedOrThrow(userId, documentId);
},
```
Add the helper next to `getOrThrow`:
```ts
async function getEnrichedOrThrow(userId: string, documentId: string) {
  const row = await repository.findByIdWithExtras({ userId, documentId });
  if (!row) throw notFound(documentId);
  return row;
}
```
Change the top-of-file type import to include `DocumentView`:
```ts
import type { Document, DocumentListRow, DocumentView } from "./documents.types.js";
```

- [ ] **Step 12: Extend `documents.schemas.ts`**

```ts
import * as v from "valibot";
import { categoryIdSchema, tagIdSchema } from "../tags/tags.schemas.js";

export const uploadQuerySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const renameBodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const documentIdSchema = v.pipe(v.string(), v.regex(/^doc_[0-9a-f]{16}$/));

export const documentViewSchema = v.picklist(["inbox", "needs_review", "all"]);

export const listDocumentsQuerySchema = v.object({
  categoryId: v.optional(categoryIdSchema),
  tagId: v.optional(tagIdSchema),
  view: v.optional(documentViewSchema, "all"),
});
```

- [ ] **Step 13: Extend the `GET /api/documents` route**

In `apps/server/src/modules/documents/documents.routes.ts`, change the import and the handler:
```ts
import { documentIdSchema, listDocumentsQuerySchema, renameBodySchema, uploadQuerySchema } from "./documents.schemas.js";
```
```ts
app.get("/api/documents", async (c) => {
  const { categoryId, tagId, view } = parseOrValidationError(listDocumentsQuerySchema, c.req.query());
  const documents = await documentsService.list({ userId: getUserId(c), categoryId, tagId, view });
  return c.json({ documents });
});
```

- [ ] **Step 14: Write the failing filter and enrichment tests**

Add to `apps/server/src/modules/documents/documents.usecases.test.ts`, in a new `describe` block:
```ts
describe("documents service filters and enrichment", () => {
  it("filters by view: inbox is unstarted rule status, needs_review is done with no category", async () => {
    const { document: pending } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: done } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const repository = createDocumentsRepository({ db });
    await repository.update({ userId, documentId: done.id, patch: { ruleStatus: "done" } });

    const inbox = await documents.list({ userId, view: "inbox" });
    expect(inbox.map((d) => d.id)).toEqual([pending.id]);

    const needsReview = await documents.list({ userId, view: "needs_review" });
    expect(needsReview.map((d) => d.id)).toEqual([done.id]);

    await repository.update({ userId, documentId: done.id, patch: { categoryId: "cat_0000000000000001", categorySource: "manual" } });
    expect((await documents.list({ userId, view: "needs_review" })).map((d) => d.id)).toEqual([]);
  });

  it("filters by categoryId including descendants, and by tagId", async () => {
    const tags = createTagsService({ db });
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    const tag = await tags.createTag({ userId, name: "Rent" });

    const { document: inTax } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: inFinance } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const { document: elsewhere } = await documents.upload({ userId, name: "c.txt", mimeType: "text/plain", body: Readable.from(["c"]) });
    await tags.setDocumentCategory({ userId, documentId: inTax.id, categoryId: tax.id });
    await tags.setDocumentCategory({ userId, documentId: inFinance.id, categoryId: finance.id });
    await tags.setDocumentTag({ userId, documentId: elsewhere.id, tagId: tag.id });

    const byFinance = await documents.list({ userId, categoryId: finance.id });
    expect(byFinance.map((d) => d.id).sort()).toEqual([inFinance.id, inTax.id].sort());
    expect(byFinance.find((d) => d.id === inTax.id)?.categoryPath).toBe("Finance / Tax");

    const byTag = await documents.list({ userId, tagId: tag.id });
    expect(byTag.map((d) => d.id)).toEqual([elsewhere.id]);
    expect(byTag[0]?.tags).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);
  });

  it("combines categoryId and tagId filters with AND", async () => {
    const tags = createTagsService({ db });
    const category = await tags.createCategory({ userId, name: "Finance" });
    const tag = await tags.createTag({ userId, name: "Rent" });
    const { document: both } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: onlyCategory } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    await tags.setDocumentCategory({ userId, documentId: both.id, categoryId: category.id });
    await tags.setDocumentTag({ userId, documentId: both.id, tagId: tag.id });
    await tags.setDocumentCategory({ userId, documentId: onlyCategory.id, categoryId: category.id });

    const result = await documents.list({ userId, categoryId: category.id, tagId: tag.id });
    expect(result.map((d) => d.id)).toEqual([both.id]);
  });

  it("get() returns the category path and tag chips for a single document", async () => {
    const tags = createTagsService({ db });
    const category = await tags.createCategory({ userId, name: "Finance" });
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await tags.setDocumentCategory({ userId, documentId: document.id, categoryId: category.id });
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail).toMatchObject({ categoryId: category.id, categoryPath: "Finance", tags: [] });
  });
});
```

- [ ] **Step 15: Run the tests**

Run: `pnpm --filter @docmind/server test -- documents storage.usecases extraction.usecases`
Expected: PASS.

- [ ] **Step 16: Add and run a route-level filter test**

Add to `apps/server/src/modules/documents/documents.routes.test.ts`:
```ts
it("filters the list by categoryId, tagId, and view", async () => {
  const created = await upload("a.txt", "hello");
  const { document } = await created.json();
  const category = (
    await (
      await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Finance" }) })
    ).json()
  ).category;
  await app.request(`/api/documents/${document.id}/category`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ categoryId: category.id }),
  });

  const byCategory = await (await app.request(`/api/documents?categoryId=${category.id}`, { headers: { cookie } })).json();
  expect(byCategory.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);
  expect(byCategory.documents[0].categoryPath).toBe("Finance");

  const inbox = await (await app.request("/api/documents?view=inbox", { headers: { cookie } })).json();
  expect(inbox.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);

  const badView = await app.request("/api/documents?view=bogus", { headers: { cookie } });
  expect(badView.status).toBe(400);
});
```

Run: `pnpm --filter @docmind/server test -- documents.routes`
Expected: PASS.

- [ ] **Step 17: Run the full server test suite and typecheck**

Run: `pnpm --filter @docmind/server test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 18: Commit**

```bash
git add apps/server/src/modules/storage/storage.usecases.ts \
        apps/server/src/modules/storage/storage.usecases.test.ts \
        apps/server/src/modules/documents \
        apps/server/src/modules/extraction/extraction.usecases.ts \
        apps/server/src/modules/extraction/extraction.usecases.test.ts
git commit -m "$(cat <<'EOF'
feat(server): filter and enrich the documents list with categories and tags

GET /api/documents gains categoryId (including descendants), tagId,
and view (inbox, needs_review, all) filters; list rows and the single
document response gain categoryId, categoryPath, and tags. Storage
keys for new uploads gain a year and month prefix. Extraction failure
on the final attempt now also fails rule_status so a document without
text never sits in Inbox forever.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 5: Client api modules and the sidebar

**Files:**
- Modify: `apps/client/src/lib/api.ts`, `api.test.ts`
- Modify: `apps/client/src/lib/documents-api.ts`, `documents-api.test.ts`
- Create: `apps/client/src/lib/tags-api.ts`, `tags-api.test.ts`
- Create: `apps/client/src/components/layout/CategoryTreeNav.tsx`, `CategoryTreeNav.test.tsx`
- Modify: `apps/client/src/components/layout/AppShell.tsx`; Create `AppShell.test.tsx`

**Interfaces:**
- Consumes: `api.get`, `api.json`, `api.del` from `api.ts`; server response shapes from Tasks 3 and 4 (`{ tags }`, `{ tag }`, `{ categories }`, `{ category }`, `{ document }`).
- Produces: `TagChip`, `TagRow`, `CategoryRow`, `TagInput`, `CategoryInput`, `tagsApi`, `categoriesApi`, `documentCategorizationApi` from `tags-api.ts`, consumed by Task 6 and Task 7. `documentsApi.list(filters?)` and the extended `DocumentRow`, consumed by Task 7. `CategoryTreeNav({ categories })`, consumed by `AppShell.tsx`.

- [ ] **Step 1: Write the failing `api.ts` tests**

Add to `apps/client/src/lib/api.test.ts`:
```ts
it("del resolves to undefined on a 204", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  expect(await api.del("/api/documents/doc_1")).toBeUndefined();
});

it("del returns a parsed body when the server sends one", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ tags: [] }), { status: 200 }));
  expect(await api.del<{ tags: unknown[] }>("/api/documents/doc_1/tags/tag_1")).toEqual({ tags: [] });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- api.test`
Expected: FAIL (or a TypeScript error on the generic call), since `del` is not yet generic.

- [ ] **Step 3: Make `api.del` generic**

In `apps/client/src/lib/api.ts`, change only the `del` method:
```ts
export const api = {
  get<T>(path: string) {
    return fetch(path, { credentials: "include" }).then((r) => handle<T>(r));
  },
  json<T>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown) {
    return fetch(path, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r));
  },
  del<T = void>(path: string) {
    return fetch(path, { method: "DELETE", credentials: "include" }).then((r) => handle<T>(r));
  },
};
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @docmind/client test -- api.test`
Expected: PASS.

- [ ] **Step 5: Write the failing `tags-api.ts` tests**

`apps/client/src/lib/tags-api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { categoriesApi, documentCategorizationApi, tagsApi } from "./tags-api";

afterEach(() => vi.restoreAllMocks());

describe("tagsApi", () => {
  it("lists, creates, updates, and removes a tag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tags: [{ id: "tag_1", name: "Rent" }] }), { status: 200 }));
    expect(await tagsApi.list()).toEqual([{ id: "tag_1", name: "Rent" }]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tag: { id: "tag_2", name: "Bills" } }), { status: 201 }));
    expect(await tagsApi.create({ name: "Bills" })).toEqual({ id: "tag_2", name: "Bills" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tag: { id: "tag_2", name: "Utilities" } }), { status: 200 }));
    expect(await tagsApi.update("tag_2", { name: "Utilities" })).toEqual({ id: "tag_2", name: "Utilities" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
    await tagsApi.remove("tag_2");
  });
});

describe("categoriesApi", () => {
  it("lists and creates a category", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ categories: [] }), { status: 200 }));
    expect(await categoriesApi.list()).toEqual([]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ category: { id: "cat_1", name: "Finance" } }), { status: 201 }));
    expect(await categoriesApi.create({ name: "Finance" })).toEqual({ id: "cat_1", name: "Finance" });
  });
});

describe("documentCategorizationApi", () => {
  it("sets a category and adds and removes a tag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: "doc_1", categoryId: "cat_1" } }), { status: 200 }));
    expect(await documentCategorizationApi.setCategory("doc_1", "cat_1")).toEqual({ id: "doc_1", categoryId: "cat_1" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tags: [{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }] }), { status: 200 }),
    );
    expect(await documentCategorizationApi.addTag("doc_1", "tag_1")).toEqual([{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tags: [] }), { status: 200 }));
    expect(await documentCategorizationApi.removeTag("doc_1", "tag_1")).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- tags-api`
Expected: FAIL, cannot find module `./tags-api`.

- [ ] **Step 7: Write `tags-api.ts`**

`apps/client/src/lib/tags-api.ts`:
```ts
import { api } from "./api";

export type TagChip = { id: string; name: string; color: string | null; auto: boolean; manual: boolean };

export type TagRow = {
  id: string;
  name: string;
  color: string | null;
  description: string;
  confidenceThreshold: number;
  autoApply: boolean;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CategoryRow = {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  description: string;
  confidenceThreshold: number;
  autoApply: boolean;
  sortOrder: number;
  path: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TagInput = {
  name: string;
  color?: string | null;
  description?: string;
  confidenceThreshold?: number;
  autoApply?: boolean;
};

export type CategoryInput = TagInput & { parentId?: string | null; sortOrder?: number };

export const tagsApi = {
  async list() {
    return (await api.get<{ tags: TagRow[] }>("/api/tags")).tags;
  },
  async create(input: TagInput) {
    return (await api.json<{ tag: TagRow }>("POST", "/api/tags", input)).tag;
  },
  async update(id: string, patch: Partial<TagInput>) {
    return (await api.json<{ tag: TagRow }>("PATCH", `/api/tags/${id}`, patch)).tag;
  },
  remove(id: string) {
    return api.del(`/api/tags/${id}`);
  },
};

export const categoriesApi = {
  async list() {
    return (await api.get<{ categories: CategoryRow[] }>("/api/categories")).categories;
  },
  async create(input: CategoryInput) {
    return (await api.json<{ category: CategoryRow }>("POST", "/api/categories", input)).category;
  },
  async update(id: string, patch: Partial<CategoryInput>) {
    return (await api.json<{ category: CategoryRow }>("PATCH", `/api/categories/${id}`, patch)).category;
  },
  remove(id: string) {
    return api.del(`/api/categories/${id}`);
  },
};

export const documentCategorizationApi = {
  async setCategory(documentId: string, categoryId: string | null) {
    return (await api.json<{ document: unknown }>("PUT", `/api/documents/${documentId}/category`, { categoryId })).document;
  },
  addTag(documentId: string, tagId: string) {
    return api.json<{ tags: TagChip[] }>("POST", `/api/documents/${documentId}/tags/${tagId}`, {}).then((r) => r.tags);
  },
  removeTag(documentId: string, tagId: string) {
    return api.del<{ tags: TagChip[] }>(`/api/documents/${documentId}/tags/${tagId}`).then((r) => r.tags);
  },
};
```

- [ ] **Step 8: Run the test**

Run: `pnpm --filter @docmind/client test -- tags-api`
Expected: PASS.

- [ ] **Step 9: Write the failing `documents-api.ts` filter tests**

Add to `apps/client/src/lib/documents-api.test.ts`:
```ts
it("builds the query string from filters", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
  await documentsApi.list({ categoryId: "cat_1", tagId: "tag_1", view: "inbox" });
  expect(fetchSpy).toHaveBeenCalledWith("/api/documents?categoryId=cat_1&tagId=tag_1&view=inbox", expect.anything());
});

it('omits view from the query string when it is "all" or absent', async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
  await documentsApi.list({ view: "all" });
  await documentsApi.list();
  expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/documents", expect.anything());
  expect(fetchSpy).toHaveBeenNthCalledWith(2, "/api/documents", expect.anything());
});
```

- [ ] **Step 10: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- documents-api`
Expected: FAIL, `documentsApi.list` does not build a query string.

- [ ] **Step 11: Update `documents-api.ts`**

Replace the top of `apps/client/src/lib/documents-api.ts`:
```ts
import { api, ApiError } from "./api";
import type { TagChip } from "./tags-api";

export type DocumentRow = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  extractionStatus: "pending" | "processing" | "done" | "failed";
  extractionError: string | null;
  categoryId: string | null;
  categoryPath: string | null;
  tags: TagChip[];
  createdAt: string;
  updatedAt: string;
};

export type DocumentDetail = DocumentRow & { extractedText: string | null; categorySource: "manual" | "auto" | null };

export type UploadResult = { document: DocumentDetail; duplicateOf?: string };

export type DocumentListFilters = { categoryId?: string; tagId?: string; view?: "inbox" | "needs_review" | "all" };

export const documentsApi = {
  async list(filters: DocumentListFilters = {}) {
    const params = new URLSearchParams();
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    if (filters.tagId) params.set("tagId", filters.tagId);
    if (filters.view && filters.view !== "all") params.set("view", filters.view);
    const qs = params.toString();
    return (await api.get<{ documents: DocumentRow[] }>(`/api/documents${qs ? `?${qs}` : ""}`)).documents;
  },
  async get(id: string) {
    return (await api.get<{ document: DocumentDetail }>(`/api/documents/${id}`)).document;
  },
```
Keep the rest of the file (`rename`, `remove`, `reextract`, `fileUrl`, `upload`) unchanged.

- [ ] **Step 12: Run the test**

Run: `pnpm --filter @docmind/client test -- documents-api`
Expected: PASS.

- [ ] **Step 13: Write the failing `CategoryTreeNav` test**

`apps/client/src/components/layout/CategoryTreeNav.test.tsx`:
```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { CategoryRow } from "@/lib/tags-api";
import { CategoryTreeNav } from "./CategoryTreeNav";

afterEach(() => cleanup());

function category(overrides: Partial<CategoryRow>): CategoryRow {
  return {
    id: "cat_x",
    name: "Category",
    parentId: null,
    color: null,
    description: "",
    confidenceThreshold: 0.7,
    autoApply: true,
    sortOrder: 0,
    path: "Category",
    documentCount: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("CategoryTreeNav", () => {
  it("renders a nested tree with recursive document counts", () => {
    const categories = [
      category({ id: "cat_1", name: "Finance", documentCount: 2 }),
      category({ id: "cat_2", name: "Tax", parentId: "cat_1", documentCount: 1, path: "Finance / Tax" }),
    ];
    render(
      <MemoryRouter>
        <CategoryTreeNav categories={categories} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Tax")).toBeInTheDocument();
    // Finance shows 3 (its own 2 plus Tax's 1); Tax shows 1 (leaf, direct only).
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows a placeholder when there are no categories", () => {
    render(
      <MemoryRouter>
        <CategoryTreeNav categories={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("No categories yet.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 14: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- CategoryTreeNav`
Expected: FAIL, cannot find module `./CategoryTreeNav`.

- [ ] **Step 15: Write `CategoryTreeNav.tsx`**

`apps/client/src/components/layout/CategoryTreeNav.tsx`:
```tsx
import { NavLink } from "react-router-dom";
import type { CategoryRow } from "@/lib/tags-api";

function childrenOf(categories: CategoryRow[], parentId: string | null): CategoryRow[] {
  return categories.filter((c) => c.parentId === parentId);
}

/** Computes the recursive count for each category: its own documentCount plus all descendants'. */
function recursiveCounts(categories: CategoryRow[]): Map<string, number> {
  const childrenMap = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    const list = childrenMap.get(c.parentId) ?? [];
    list.push(c.id);
    childrenMap.set(c.parentId, list);
  }
  const byId = new Map(categories.map((c) => [c.id, c]));
  const cache = new Map<string, number>();
  function total(id: string): number {
    if (cache.has(id)) return cache.get(id)!;
    const node = byId.get(id);
    if (!node) return 0;
    let sum = node.documentCount;
    for (const childId of childrenMap.get(id) ?? []) sum += total(childId);
    cache.set(id, sum);
    return sum;
  }
  for (const c of categories) total(c.id);
  return cache;
}

function CategoryNode({ category, categories, depth, counts }: { category: CategoryRow; categories: CategoryRow[]; depth: number; counts: Map<string, number> }) {
  const children = childrenOf(categories, category.id);
  const count = counts.get(category.id) ?? category.documentCount;
  return (
    <div>
      <NavLink
        to={`/documents?categoryId=${category.id}`}
        className="flex items-center justify-between gap-2 rounded px-3 py-1.5 text-sm hover:bg-muted"
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        <span className="truncate">{category.name}</span>
        {count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
      </NavLink>
      {children.map((child) => (
        <CategoryNode key={child.id} category={child} categories={categories} depth={depth + 1} counts={counts} />
      ))}
    </div>
  );
}

export function CategoryTreeNav({ categories }: { categories: CategoryRow[] }) {
  const roots = childrenOf(categories, null);
  if (roots.length === 0) return <p className="px-3 text-xs text-muted-foreground">No categories yet.</p>;
  const counts = recursiveCounts(categories);
  return (
    <nav className="flex flex-col gap-0.5">
      {roots.map((c) => (
        <CategoryNode key={c.id} category={c} categories={categories} depth={0} counts={counts} />
      ))}
    </nav>
  );
}
```

- [ ] **Step 16: Run the test**

Run: `pnpm --filter @docmind/client test -- CategoryTreeNav`
Expected: PASS.

- [ ] **Step 17: Write the failing `AppShell` test**

`apps/client/src/components/layout/AppShell.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

afterEach(() => cleanup());

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    list: vi.fn(async (filters?: { view?: string }) => {
      if (filters?.view === "inbox") return [{ id: "doc_1" }];
      if (filters?.view === "needs_review") return [{ id: "doc_2" }, { id: "doc_3" }];
      return [];
    }),
  },
}));

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: { list: vi.fn(async () => [{ id: "cat_1", name: "Finance", parentId: null, documentCount: 1, path: "Finance" }]) },
  tagsApi: { list: vi.fn(async () => [{ id: "tag_1", name: "Rent", documentCount: 3 }]) },
}));

vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn(async () => {}) } }));

// AppShell renders an <Outlet/>, which needs a real route match to resolve without
// throwing. A plain child route with no element renders nothing there, which is fine
// since this test only asserts on the sidebar.
function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/documents"]}>
      <QueryClientProvider client={new QueryClient()}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/documents" element={null} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  it("shows Inbox and Needs review counts, the category tree, and the tag list", async () => {
    renderShell();
    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(await screen.findByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 18: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- AppShell`
Expected: FAIL, `AppShell` does not render these sections yet.

- [ ] **Step 19: Rewrite `AppShell.tsx`**

`apps/client/src/components/layout/AppShell.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { documentsApi } from "@/lib/documents-api";
import { categoriesApi, tagsApi } from "@/lib/tags-api";
import { CategoryTreeNav } from "./CategoryTreeNav";

const bottomLinks = [
  { to: "/rules", label: "Rules" },
  { to: "/jobs", label: "Jobs" },
  { to: "/settings", label: "Settings" },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `rounded px-3 py-2 text-sm ${isActive ? "bg-muted font-medium" : "hover:bg-muted"}`;
}

function CountRow({ to, label, count }: { to: string; label: string; count: number }) {
  return (
    <NavLink to={to} className="flex items-center justify-between rounded px-3 py-2 text-sm hover:bg-muted">
      <span>{label}</span>
      {count > 0 && <Badge variant="secondary">{count}</Badge>}
    </NavLink>
  );
}

export function AppShell() {
  const { data: inbox = [] } = useQuery({ queryKey: ["documents", { view: "inbox" }], queryFn: () => documentsApi.list({ view: "inbox" }) });
  const { data: needsReview = [] } = useQuery({ queryKey: ["documents", { view: "needs_review" }], queryFn: () => documentsApi.list({ view: "needs_review" }) });
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r p-4 flex flex-col gap-4 overflow-y-auto">
        <div className="text-lg font-semibold">DocMind</div>

        <nav className="flex flex-col gap-1">
          <NavLink to="/documents" end className={navLinkClass}>
            All documents
          </NavLink>
          <CountRow to="/documents?view=inbox" label="Inbox" count={inbox.length} />
          <CountRow to="/documents?view=needs_review" label="Needs review" count={needsReview.length} />
        </nav>

        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">Categories</span>
            <NavLink to="/categories" className="text-xs underline-offset-2 hover:underline">
              Manage
            </NavLink>
          </div>
          <CategoryTreeNav categories={categories} />
        </div>

        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <span className="text-xs font-medium uppercase text-muted-foreground">Tags</span>
            <NavLink to="/tags" className="text-xs underline-offset-2 hover:underline">
              Manage
            </NavLink>
          </div>
          {tags.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">No tags yet.</p>
          ) : (
            <nav className="flex flex-col gap-0.5">
              {tags.map((t) => (
                <CountRow key={t.id} to={`/documents?tagId=${t.id}`} label={t.name} count={t.documentCount} />
              ))}
            </nav>
          )}
        </div>

        <nav className="flex flex-col gap-1 mt-auto pt-4 border-t">
          {bottomLinks.map((l) => (
            <NavLink key={l.to} to={l.to} className={navLinkClass}>
              {l.label}
            </NavLink>
          ))}
          <Button variant="ghost" className="w-full justify-start" onClick={() => authClient.signOut().then(() => window.location.assign("/sign-in"))}>
            Sign out
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 20: Run the test**

Run: `pnpm --filter @docmind/client test -- AppShell`
Expected: PASS.

- [ ] **Step 21: Run the full client test suite**

Run: `pnpm --filter @docmind/client test`
Expected: PASS.

- [ ] **Step 22: Commit**

```bash
git add apps/client/src/lib/api.ts \
        apps/client/src/lib/api.test.ts \
        apps/client/src/lib/documents-api.ts \
        apps/client/src/lib/documents-api.test.ts \
        apps/client/src/lib/tags-api.ts \
        apps/client/src/lib/tags-api.test.ts \
        apps/client/src/components/layout/CategoryTreeNav.tsx \
        apps/client/src/components/layout/CategoryTreeNav.test.tsx \
        apps/client/src/components/layout/AppShell.tsx \
        apps/client/src/components/layout/AppShell.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): add tags and categories api clients and the sidebar

Adds tagsApi, categoriesApi, and documentCategorizationApi, extends
documentsApi.list with categoryId, tagId, and view filters, and
grows the sidebar with Inbox and Needs review counts, a category
tree, and a tag list, each linking into the filtered library.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 6: Client manage pages for tags and categories

**Files:**
- Create: `apps/client/src/pages/tags/TagsPage.tsx`, `TagsPage.test.tsx`
- Create: `apps/client/src/pages/categories/CategoriesPage.tsx`, `CategoriesPage.test.tsx`
- Modify: `apps/client/src/App.tsx`

**Interfaces:**
- Consumes: `tagsApi`, `categoriesApi`, `TagRow`, `CategoryRow`, `TagInput`, `CategoryInput` from `@/lib/tags-api` (Task 5). `Button`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`, `Input`, `Label`, `Badge` from `@/components/ui/*`.
- Produces: `TagsPage`, `CategoriesPage`, routed at `/tags` and `/categories`, consumed by `App.tsx` and linked from `AppShell.tsx` (Task 5, already wired to these paths).

- [ ] **Step 1: Write the failing `TagsPage` test**

`apps/client/src/pages/tags/TagsPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagsPage } from "./TagsPage";

afterEach(() => cleanup());

const listMock = vi.fn(async () => [
  {
    id: "tag_1",
    name: "Rent",
    color: "#4f46e5",
    description: "Monthly rent",
    confidenceThreshold: 0.7,
    autoApply: true,
    documentCount: 2,
    createdAt: "",
    updatedAt: "",
  },
]);
const createMock = vi.fn(async (input: unknown) => ({ id: "tag_2", documentCount: 0, createdAt: "", updatedAt: "", ...(input as object) }));
const removeMock = vi.fn(async () => undefined);

vi.mock("@/lib/tags-api", () => ({
  tagsApi: {
    list: () => listMock(),
    create: (input: unknown) => createMock(input),
    update: vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) })),
    remove: (id: string) => removeMock(id),
  },
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TagsPage />
    </QueryClientProvider>,
  );
}

describe("TagsPage", () => {
  it("lists existing tags with their document count", async () => {
    renderPage();
    expect(await screen.findByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("2 documents")).toBeInTheDocument();
  });

  it("creates a new tag", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New tag"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Bills" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Bills" })));
  });

  it("deletes a tag after confirming", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Delete"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("tag_1"));
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- TagsPage`
Expected: FAIL, cannot find module `./TagsPage`.

- [ ] **Step 3: Write `TagsPage.tsx`**

`apps/client/src/pages/tags/TagsPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tagsApi, type TagInput, type TagRow } from "@/lib/tags-api";

const emptyForm: TagInput = { name: "", color: "", description: "", confidenceThreshold: 0.7, autoApply: true };

function TagForm({ initial, onSubmit, submitting }: { initial: TagInput; onSubmit: (input: TagInput) => void; submitting: boolean }) {
  const [form, setForm] = useState<TagInput>(initial);
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="tag-name">Name</Label>
        <Input id="tag-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="tag-description">Description (the rule)</Label>
        <textarea
          id="tag-description"
          className="w-full min-h-24 rounded border bg-transparent p-2 text-sm"
          maxLength={300}
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <p className="text-xs text-muted-foreground mt-1">{(form.description ?? "").length}/300. Leave empty to keep this tag manual only.</p>
      </div>
      <div className="flex items-center gap-3">
        <Label htmlFor="tag-color">Color</Label>
        <Input
          id="tag-color"
          value={form.color ?? ""}
          placeholder="#4f46e5"
          className="w-32"
          onChange={(e) => setForm({ ...form, color: e.target.value || null })}
        />
        {form.color && <span className="inline-block h-5 w-5 rounded border" style={{ backgroundColor: form.color }} />}
      </div>
      <div>
        <Label htmlFor="tag-threshold">Confidence threshold: {(form.confidenceThreshold ?? 0.7).toFixed(2)}</Label>
        <input
          id="tag-threshold"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.confidenceThreshold ?? 0.7}
          className="w-full"
          onChange={(e) => setForm({ ...form, confidenceThreshold: Number(e.target.value) })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.autoApply ?? true} onChange={(e) => setForm({ ...form, autoApply: e.target.checked })} />
        Automatic: let the sorter apply this tag
      </label>
      <Button disabled={submitting || !form.name.trim()} onClick={() => onSubmit(form)}>
        Save
      </Button>
      <p className="text-xs text-muted-foreground">Test on a document is available once the sorting engine ships.</p>
    </div>
  );
}

export function TagsPage() {
  const queryClient = useQueryClient();
  const { data: tags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TagRow | null>(null);
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const create = useMutation({
    mutationFn: (input: TagInput) => tagsApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setCreateOpen(false);
      toast.success("Tag created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (input: TagInput) => tagsApi.update(editing!.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setEditing(null);
      toast.success("Tag saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => tagsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setDeleting(null);
      toast.success("Tag deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tags</h1>
        <Button onClick={() => setCreateOpen(true)}>New tag</Button>
      </div>

      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags yet.</p>
      ) : (
        <div className="grid gap-3">
          {tags.map((t) => (
            <Card key={t.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {t.color && <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: t.color }} />}
                  {t.name}
                  <Badge variant="secondary">{t.documentCount} documents</Badge>
                  {!t.autoApply && <Badge variant="outline">Manual only</Badge>}
                </CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(t)}>
                    Delete
                  </Button>
                </div>
              </CardHeader>
              {t.description && <CardContent className="text-sm text-muted-foreground">{t.description}</CardContent>}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New tag</DialogTitle>
          </DialogHeader>
          <TagForm initial={emptyForm} submitting={create.isPending} onSubmit={(input) => create.mutate(input)} />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit tag</DialogTitle>
          </DialogHeader>
          {editing && (
            <TagForm
              initial={{
                name: editing.name,
                color: editing.color,
                description: editing.description,
                confidenceThreshold: editing.confidenceThreshold,
                autoApply: editing.autoApply,
              }}
              submitting={update.isPending}
              onSubmit={(input) => update.mutate(input)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this tag?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Removes it from every document. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleting && remove.mutate(deleting.id)} disabled={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @docmind/client test -- TagsPage`
Expected: PASS.

- [ ] **Step 5: Write the failing `CategoriesPage` test**

`apps/client/src/pages/categories/CategoriesPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoriesPage } from "./CategoriesPage";

afterEach(() => cleanup());

const listMock = vi.fn(async () => [
  {
    id: "cat_1",
    name: "Finance",
    parentId: null,
    color: null,
    description: "",
    confidenceThreshold: 0.7,
    autoApply: true,
    sortOrder: 0,
    path: "Finance",
    documentCount: 3,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "cat_2",
    name: "Personal",
    parentId: null,
    color: null,
    description: "",
    confidenceThreshold: 0.7,
    autoApply: true,
    sortOrder: 1,
    path: "Personal",
    documentCount: 0,
    createdAt: "",
    updatedAt: "",
  },
]);
const createMock = vi.fn(async (input: unknown) => ({ id: "cat_3", documentCount: 0, sortOrder: 2, path: "Tax", createdAt: "", updatedAt: "", ...(input as object) }));
const removeMock = vi.fn(async () => undefined);
const updateMock = vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: {
    list: () => listMock(),
    create: (input: unknown) => createMock(input),
    update: (id: string, patch: unknown) => updateMock(id, patch),
    remove: (id: string) => removeMock(id),
  },
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CategoriesPage />
    </QueryClientProvider>,
  );
}

describe("CategoriesPage", () => {
  it("lists existing categories with their path and document count", async () => {
    renderPage();
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("3 documents")).toBeInTheDocument();
  });

  it("creates a new category with a parent", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Tax" } });
    fireEvent.change(dialog.getByLabelText("Parent"), { target: { value: "cat_1" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Tax", parentId: "cat_1" })));
  });

  it("moves a category down by swapping sortOrder with its next sibling", async () => {
    renderPage();
    await screen.findByText("Finance");
    fireEvent.click(screen.getByLabelText("Move Finance down"));
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith("cat_1", { sortOrder: 1 });
      expect(updateMock).toHaveBeenCalledWith("cat_2", { sortOrder: 0 });
    });
  });

  it("does nothing when moving the first category up", async () => {
    renderPage();
    await screen.findByText("Finance");
    fireEvent.click(screen.getByLabelText("Move Finance up"));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("deletes a category after confirming", async () => {
    renderPage();
    fireEvent.click((await screen.findAllByText("Delete"))[0]);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("cat_1"));
  });
});
```

- [ ] **Step 6: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- CategoriesPage`
Expected: FAIL, cannot find module `./CategoriesPage`.

- [ ] **Step 7: Write `CategoriesPage.tsx`**

`apps/client/src/pages/categories/CategoriesPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { categoriesApi, type CategoryInput, type CategoryRow } from "@/lib/tags-api";

const emptyForm: CategoryInput = { name: "", parentId: null, color: "", description: "", confidenceThreshold: 0.7, autoApply: true };

function CategoryForm({
  initial,
  categories,
  excludeId,
  onSubmit,
  submitting,
}: {
  initial: CategoryInput;
  categories: CategoryRow[];
  excludeId?: string;
  onSubmit: (input: CategoryInput) => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<CategoryInput>(initial);
  const parentOptions = categories.filter((c) => c.id !== excludeId);
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="category-name">Name</Label>
        <Input id="category-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="category-parent">Parent</Label>
        <select
          id="category-parent"
          className="w-full rounded border bg-transparent p-2 text-sm"
          value={form.parentId ?? ""}
          onChange={(e) => setForm({ ...form, parentId: e.target.value || null })}
        >
          <option value="">No parent (top level)</option>
          {parentOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.path}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="category-description">Description (the rule)</Label>
        <textarea
          id="category-description"
          className="w-full min-h-24 rounded border bg-transparent p-2 text-sm"
          maxLength={2000}
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <p className="text-xs text-muted-foreground mt-1">{(form.description ?? "").length}/2000. Leave empty to keep this category manual only.</p>
      </div>
      <div className="flex items-center gap-3">
        <Label htmlFor="category-color">Color</Label>
        <Input
          id="category-color"
          value={form.color ?? ""}
          placeholder="#4f46e5"
          className="w-32"
          onChange={(e) => setForm({ ...form, color: e.target.value || null })}
        />
        {form.color && <span className="inline-block h-5 w-5 rounded border" style={{ backgroundColor: form.color }} />}
      </div>
      <div>
        <Label htmlFor="category-threshold">Confidence threshold: {(form.confidenceThreshold ?? 0.7).toFixed(2)}</Label>
        <input
          id="category-threshold"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.confidenceThreshold ?? 0.7}
          className="w-full"
          onChange={(e) => setForm({ ...form, confidenceThreshold: Number(e.target.value) })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.autoApply ?? true} onChange={(e) => setForm({ ...form, autoApply: e.target.checked })} />
        Automatic: let the sorter file documents here
      </label>
      <Button disabled={submitting || !form.name.trim()} onClick={() => onSubmit(form)}>
        Save
      </Button>
      <p className="text-xs text-muted-foreground">Test on a document is available once the sorting engine ships.</p>
    </div>
  );
}

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = useState<CategoryRow | null>(null);

  const create = useMutation({
    mutationFn: (input: CategoryInput) => categoriesApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setCreateOpen(false);
      toast.success("Category created");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (input: CategoryInput) => categoriesApi.update(editing!.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setEditing(null);
      toast.success("Category saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      setDeleting(null);
      toast.success("Category deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reorder = useMutation({
    mutationFn: ([a, b]: [{ id: string; sortOrder: number }, { id: string; sortOrder: number }]) =>
      Promise.all([categoriesApi.update(a.id, { sortOrder: a.sortOrder }), categoriesApi.update(b.id, { sortOrder: b.sortOrder })]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["categories"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  function siblingsOf(category: CategoryRow): CategoryRow[] {
    return categories.filter((c) => c.parentId === category.parentId).sort((x, y) => x.sortOrder - y.sortOrder);
  }

  function moveCategory(category: CategoryRow, direction: -1 | 1) {
    const siblings = siblingsOf(category);
    const index = siblings.findIndex((c) => c.id === category.id);
    const neighbor = siblings[index + direction];
    if (!neighbor) return;
    reorder.mutate([
      { id: category.id, sortOrder: neighbor.sortOrder },
      { id: neighbor.id, sortOrder: category.sortOrder },
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Categories</h1>
        <Button onClick={() => setCreateOpen(true)}>New category</Button>
      </div>

      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <div className="grid gap-3">
          {categories.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  {c.color && <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: c.color }} />}
                  {c.path}
                  <Badge variant="secondary">{c.documentCount} documents</Badge>
                  {!c.autoApply && <Badge variant="outline">Manual only</Badge>}
                </CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" aria-label={`Move ${c.name} up`} onClick={() => moveCategory(c, -1)}>
                    Up
                  </Button>
                  <Button size="sm" variant="outline" aria-label={`Move ${c.name} down`} onClick={() => moveCategory(c, 1)}>
                    Down
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(c)}>
                    Delete
                  </Button>
                </div>
              </CardHeader>
              {c.description && <CardContent className="text-sm text-muted-foreground">{c.description}</CardContent>}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
          </DialogHeader>
          <CategoryForm initial={emptyForm} categories={categories} submitting={create.isPending} onSubmit={(input) => create.mutate(input)} />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit category</DialogTitle>
          </DialogHeader>
          {editing && (
            <CategoryForm
              initial={{
                name: editing.name,
                parentId: editing.parentId,
                color: editing.color,
                description: editing.description,
                confidenceThreshold: editing.confidenceThreshold,
                autoApply: editing.autoApply,
              }}
              categories={categories}
              excludeId={editing.id}
              submitting={update.isPending}
              onSubmit={(input) => update.mutate(input)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this category?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Its subcategories move up one level and its documents lose this category. This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleting && remove.mutate(deleting.id)} disabled={remove.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 8: Run the test**

Run: `pnpm --filter @docmind/client test -- CategoriesPage`
Expected: PASS.

- [ ] **Step 9: Wire the routes into `App.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { authClient } from "@/lib/auth-client";
import { SignInPage } from "@/pages/auth/SignInPage";
import { CategoriesPage } from "@/pages/categories/CategoriesPage";
import { DocumentsPage } from "@/pages/documents/DocumentsPage";
import { DocumentDetailPage } from "@/pages/documents/DocumentDetailPage";
import { JobsPage } from "@/pages/jobs/JobsPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { TagsPage } from "@/pages/tags/TagsPage";

const queryClient = new QueryClient();

function RequireSession({ children }: { children: React.ReactNode }) {
  const { data, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!data) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

function Placeholder({ title }: { title: string }) {
  return <h1 className="text-xl font-semibold">{title} arrives in a later milestone</h1>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route
            element={
              <RequireSession>
                <AppShell />
              </RequireSession>
            }
          >
            <Route index element={<Navigate to="/documents" replace />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/documents/:id" element={<DocumentDetailPage />} />
            <Route path="/categories" element={<CategoriesPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/rules" element={<Placeholder title="Rules" />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
```

- [ ] **Step 10: Run the full client test suite**

Run: `pnpm --filter @docmind/client test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/client/src/pages/tags \
        apps/client/src/pages/categories \
        apps/client/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(client): add tags and categories manage pages

Adds /tags and /categories pages to create, edit, reorder, and
delete tags and categories: name, color, description with its
character limit, a confidence threshold slider defaulting to 0.7,
and an automatic switch. Categories also get a parent picker and
Up/Down sibling reordering. Test on a document is disabled with a
note until C3.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 7: Document page pickers and library row chips

**Files:**
- Modify: `apps/client/src/pages/documents/DocumentsPage.tsx`; Create `DocumentsPage.test.tsx`
- Modify: `apps/client/src/pages/documents/DocumentDetailPage.tsx`; Create `DocumentDetailPage.test.tsx`

**Interfaces:**
- Consumes: `documentsApi.list(filters)`, extended `DocumentRow`/`DocumentDetail` from `@/lib/documents-api` (Task 5). `categoriesApi.list`, `tagsApi.list`, `documentCategorizationApi.setCategory/addTag/removeTag` from `@/lib/tags-api` (Task 5).
- Produces: Nothing consumed by later tasks; this is the last plan task that touches page components.

- [ ] **Step 1: Write the failing `DocumentsPage` test**

`apps/client/src/pages/documents/DocumentsPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

afterEach(() => cleanup());

const listMock = vi.fn(async () => [
  {
    id: "doc_1",
    name: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 100,
    extractionStatus: "done",
    extractionError: null,
    categoryId: "cat_1",
    categoryPath: "Finance / Tax",
    tags: [{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
]);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: { list: (filters?: unknown) => listMock(filters) },
}));
vi.mock("@/components/documents/UploadDropzone", () => ({ UploadDropzone: () => null }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient()}>
        <Routes>
          <Route path="/documents" element={<DocumentsPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("DocumentsPage", () => {
  it("shows the category path and tag chips for each row", async () => {
    renderAt("/documents");
    expect(await screen.findByText("Finance / Tax")).toBeInTheDocument();
    expect(screen.getByText("Rent")).toBeInTheDocument();
  });

  it("reads categoryId, tagId, and view from the URL and passes them to the api", async () => {
    renderAt("/documents?categoryId=cat_1&tagId=tag_1&view=inbox");
    await screen.findByText("invoice.pdf");
    expect(listMock).toHaveBeenCalledWith({ categoryId: "cat_1", tagId: "tag_1", view: "inbox" });
    expect(screen.getByText("Inbox")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- DocumentsPage`
Expected: FAIL, `DocumentsPage` does not render a Category or Tags column and does not read the URL yet.

- [ ] **Step 3: Rewrite `DocumentsPage.tsx`**

`apps/client/src/pages/documents/DocumentsPage.tsx`:
```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { documentsApi, type DocumentListFilters } from "@/lib/documents-api";
import { formatBytes, formatDate } from "@/lib/format";

const VIEW_LABELS: Record<string, string> = { inbox: "Inbox", needs_review: "Needs review" };

export function DocumentsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const filters: DocumentListFilters = {
    categoryId: searchParams.get("categoryId") ?? undefined,
    tagId: searchParams.get("tagId") ?? undefined,
    view: (searchParams.get("view") as DocumentListFilters["view"]) ?? "all",
  };
  const { data: documents = [], isLoading } = useQuery({
    queryKey: ["documents", filters],
    queryFn: () => documentsApi.list(filters),
    refetchInterval: (query) => (query.state.data?.some((d) => d.extractionStatus === "pending" || d.extractionStatus === "processing") ? 3000 : false),
  });

  const filterLabel = filters.view && filters.view !== "all" ? VIEW_LABELS[filters.view] : null;
  const hasFilter = Boolean(filterLabel || filters.categoryId || filters.tagId);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">{filterLabel ?? "Documents"}</h1>
        {hasFilter && (
          <Link to="/documents" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Clear filter
          </Link>
        )}
      </div>
      <UploadDropzone onUploaded={() => queryClient.invalidateQueries({ queryKey: ["documents"] })} />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents match this view.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Text</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link to={`/documents/${d.id}`} className="underline-offset-2 hover:underline">
                    {d.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{d.categoryPath ?? "None"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {d.tags.map((t) => (
                      <Badge key={t.id} variant="outline">
                        {t.name}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{d.mimeType ?? "unknown"}</TableCell>
                <TableCell>{d.sizeBytes == null ? "" : formatBytes(d.sizeBytes)}</TableCell>
                <TableCell>{formatDate(d.createdAt)}</TableCell>
                <TableCell>
                  <Badge variant={d.extractionStatus === "failed" ? "destructive" : "secondary"}>{d.extractionStatus}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @docmind/client test -- DocumentsPage`
Expected: PASS.

- [ ] **Step 5: Write the failing `DocumentDetailPage` picker tests**

`apps/client/src/pages/documents/DocumentDetailPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentDetailPage } from "./DocumentDetailPage";

afterEach(() => cleanup());

const documentDetail = {
  id: "doc_1",
  name: "invoice.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
  extractionStatus: "done" as const,
  extractionError: null,
  extractedText: "some text",
  categoryId: null,
  categoryPath: null,
  categorySource: null,
  tags: [{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const getMock = vi.fn(async () => documentDetail);
const setCategoryMock = vi.fn(async (id: string, categoryId: string | null) => ({ ...documentDetail, categoryId }));
const addTagMock = vi.fn(async () => [...documentDetail.tags, { id: "tag_2", name: "Bills", color: null, auto: false, manual: true }]);
const removeTagMock = vi.fn(async () => []);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    get: () => getMock(),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
    rename: vi.fn(),
    remove: vi.fn(),
    reextract: vi.fn(),
  },
}));

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: { list: vi.fn(async () => [{ id: "cat_1", name: "Finance", path: "Finance" }]) },
  tagsApi: { list: vi.fn(async () => [{ id: "tag_1", name: "Rent" }, { id: "tag_2", name: "Bills" }]) },
  documentCategorizationApi: {
    setCategory: (id: string, categoryId: string | null) => setCategoryMock(id, categoryId),
    addTag: (id: string, tagId: string) => addTagMock(id, tagId),
    removeTag: (id: string, tagId: string) => removeTagMock(id, tagId),
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/documents/doc_1"]}>
      <QueryClientProvider client={new QueryClient()}>
        <Routes>
          <Route path="/documents/:id" element={<DocumentDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("DocumentDetailPage pickers", () => {
  it("shows the current tag and lets the category be changed", async () => {
    renderPage();
    expect(await screen.findByText("Rent")).toBeInTheDocument();
    const select = await screen.findByDisplayValue("No category");
    fireEvent.change(select, { target: { value: "cat_1" } });
    await waitFor(() => expect(setCategoryMock).toHaveBeenCalledWith("doc_1", "cat_1"));
  });

  it("adds and removes a tag", async () => {
    renderPage();
    const addSelect = await screen.findByDisplayValue("Add a tag");
    fireEvent.change(addSelect, { target: { value: "tag_2" } });
    await waitFor(() => expect(addTagMock).toHaveBeenCalledWith("doc_1", "tag_2"));

    fireEvent.click(screen.getByLabelText("Remove Rent"));
    await waitFor(() => expect(removeTagMock).toHaveBeenCalledWith("doc_1", "tag_1"));
  });
});
```

- [ ] **Step 6: Run the test to see it fail**

Run: `pnpm --filter @docmind/client test -- DocumentDetailPage`
Expected: FAIL, no category or tag picker exists yet.

- [ ] **Step 7: Add the pickers to `DocumentDetailPage.tsx`**

Add these imports to the top of `apps/client/src/pages/documents/DocumentDetailPage.tsx`:
```tsx
import { categoriesApi, documentCategorizationApi, tagsApi } from "@/lib/tags-api";
```

Add these two components above `DocumentDetailPage` (below the existing `Preview` function):
```tsx
function CategoryPicker({ document, id, queryClient }: { document: DocumentDetail; id: string; queryClient: ReturnType<typeof useQueryClient> }) {
  const { data: categories = [] } = useQuery({ queryKey: ["categories"], queryFn: categoriesApi.list });
  const setCategory = useMutation({
    mutationFn: (categoryId: string | null) => documentCategorizationApi.setCategory(id, categoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Category updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex items-center gap-2">
      <select
        className="rounded border bg-transparent p-2 text-sm"
        value={document.categoryId ?? ""}
        onChange={(e) => setCategory.mutate(e.target.value || null)}
      >
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.path}
          </option>
        ))}
      </select>
      {document.categorySource === "auto" && <Badge variant="outline">Auto</Badge>}
    </div>
  );
}

function TagPicker({ document, id, queryClient }: { document: DocumentDetail; id: string; queryClient: ReturnType<typeof useQueryClient> }) {
  const { data: allTags = [] } = useQuery({ queryKey: ["tags"], queryFn: tagsApi.list });
  const addTag = useMutation({
    mutationFn: (tagId: string) => documentCategorizationApi.addTag(id, tagId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeTag = useMutation({
    mutationFn: (tagId: string) => documentCategorizationApi.removeTag(id, tagId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const attachedIds = new Set(document.tags.map((t) => t.id));
  const available = allTags.filter((t) => !attachedIds.has(t.id));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {document.tags.map((t) => (
        <Badge key={t.id} variant="secondary" className="flex items-center gap-1">
          {t.name}
          {t.auto && <span className="text-xs text-muted-foreground">(auto)</span>}
          <button type="button" aria-label={`Remove ${t.name}`} className="ml-1" onClick={() => removeTag.mutate(t.id)}>
            x
          </button>
        </Badge>
      ))}
      {available.length > 0 && (
        <select className="rounded border bg-transparent p-1 text-xs" value="" onChange={(e) => e.target.value && addTag.mutate(e.target.value)}>
          <option value="">Add a tag</option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
```

Inside `DocumentDetailPage`, add the pickers right after the header `div` and before `<Preview .../>`:
```tsx
<div className="flex flex-col gap-2">
  <CategoryPicker document={document} id={id} queryClient={queryClient} />
  <TagPicker document={document} id={id} queryClient={queryClient} />
</div>

<Preview id={id} mimeType={document.mimeType} />
```

- [ ] **Step 8: Run the test**

Run: `pnpm --filter @docmind/client test -- DocumentDetailPage`
Expected: PASS.

- [ ] **Step 9: Run the full client test suite and typecheck**

Run: `pnpm --filter @docmind/client test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/client/src/pages/documents/DocumentsPage.tsx \
        apps/client/src/pages/documents/DocumentsPage.test.tsx \
        apps/client/src/pages/documents/DocumentDetailPage.tsx \
        apps/client/src/pages/documents/DocumentDetailPage.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): add category and tag pickers and library row chips

The library table shows each document's category path and tag chips
and reads categoryId, tagId, and view from the URL so the sidebar's
links filter it. The document page gains a category picker and a
tag picker with an automatic mark on chips and the category set by
the sorter.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

### Task 8: Docs update and root verification

**Files:**
- Modify: `DOCMIND-DESIGN.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by other tasks; this is the last task in the plan.

- [ ] **Step 1: Update the Data Model section's Categorization block**

In `DOCMIND-DESIGN.md`, replace this block (the `-- Categorization` section, currently between the `documents` table and the `-- Rules Engine` comment):
```sql
-- Categorization
categories (id, user_id, name, parent_id, color)
tags (id, user_id, name, color)
document_tags (
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  applied_by_rule INTEGER NOT NULL DEFAULT 0,
  applied_by_manual INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, tag_id)
)
document_categories (same shape, with category_id)
-- One row per pair. A rule and a manual action can both apply the same tag; each
-- source is tracked and removed independently. The row goes away when both are 0.
-- On re-evaluation or rule deletion, applied_by_rule is set to 0 for a pair only when
-- no remaining active rule with a passing evaluation targets that tag for that
-- document. rule_evaluations is the record used to decide that.
```
with:
```sql
-- Categorization
categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- unique among siblings, case-insensitive
  parent_id TEXT,                        -- null at the root; no cycles
  color TEXT,
  description TEXT NOT NULL DEFAULT '',  -- up to 2000 characters; the plain-language rule
  confidence_threshold REAL NOT NULL DEFAULT 0.7,
  auto_apply INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- unique per user, case-insensitive
  color TEXT,
  description TEXT NOT NULL DEFAULT '',  -- up to 300 characters; the plain-language rule
  confidence_threshold REAL NOT NULL DEFAULT 0.7,
  auto_apply INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
document_tags (
  document_id TEXT NOT NULL,             -- ON DELETE CASCADE to documents
  tag_id TEXT NOT NULL,                  -- ON DELETE CASCADE to tags
  applied_by_manual INTEGER NOT NULL DEFAULT 0,
  applied_by_auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, tag_id)
)
-- documents also carries category_id (nullable) and category_source ('manual' | 'auto' |
-- null): a document has at most one category, so there is no document_categories table.
-- One document_tags row per pair. A rule and a manual action can both apply the same
-- tag; each source is tracked and removed independently. The row goes away when both
-- flags are 0. There is no separate rules table: a non-empty description plus
-- auto_apply on a tag or category is the rule. The sorting engine (Milestone C,
-- plan C3) adds a sort_evaluations table and the cleanup logic for applied_by_auto.
```

- [ ] **Step 2: Update the Storage Layer section's key format**

In `DOCMIND-DESIGN.md`, in the Storage Layer section's driver list, change:
```
- **Local.** Root path, default `./documents`. Keys are `userId/documentId/filename`,
  resolved inside the root with traversal rejected. Guide: absolute paths, permissions,
  Docker volumes.
```
to:
```
- **Local.** Root path, default `./documents`. Keys are
  `userId/yyyy/mm/documentId/filename` using the upload time in UTC, so no folder grows
  without bound, resolved inside the root with traversal rejected. Existing keys are not
  migrated when this format changed in Milestone C. Guide: absolute paths, permissions,
  Docker volumes.
```

- [ ] **Step 3: Confirm no CLAUDE.md change is needed**

`CLAUDE.md` describes conventions and workflow, not the data model or feature list; nothing in this plan changes a convention, a command, or a workflow step. No edit is needed. State this explicitly when reporting the task done, so a reviewer does not go looking for a missed edit.

- [ ] **Step 4: Root verification**

Run from the repository root:
```bash
source ~/.nvm/nvm.sh && nvm use 22 && corepack enable
pnpm typecheck
pnpm test
```
Expected: PASS for both server and client workspaces, with the full test count higher than before this plan (every task added tests and none were removed).

- [ ] **Step 5: Commit**

```bash
git add DOCMIND-DESIGN.md
git commit -m "$(cat <<'EOF'
docs: update the data model for tags, categories, and the storage key layout

Replaces the design doc's placeholder categorization tables with the
shipped categories, tags, and document_tags schema (descriptions and
auto_apply as the rules, no separate rules table, no
document_categories table since a document has one category), and
updates the local driver's key format to include the year and month.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01StVmb7TK3ajFeKogfXKR46
EOF
)"
```

---

## Plan review rulings

Applied by plan-reviewer on 2026-09-16. Each ruling is a fix applied directly to the plan text above.

1. **CategoryInput missing sortOrder (blocker).** `CategoriesPage.tsx` calls `categoriesApi.update(id, { sortOrder })` but the `CategoryInput` type had no `sortOrder` field; TypeScript would reject it. Fixed: added `sortOrder?: number` to `CategoryInput` in Task 5.
2. **PRAGMA foreign_keys not verified (blocker).** The plan relies on libsql enforcing foreign keys by default for ON DELETE CASCADE, but the database module has no explicit PRAGMA and no test asserts it. Fixed: added a "has foreign key enforcement enabled" test to Task 1 Step 9 so a cascade failure surfaces immediately rather than as a silent orphan row.
3. **Sidebar tree counts mismatch the filter (major).** Decision 11 said counts are direct only, but the category filter in `listByUser` includes descendants. A parent category with 2 direct docs and a child with 3 would show "2" in the sidebar badge but 5 documents when clicked. Fixed: `CategoryTreeNav` now computes recursive counts client-side via a `recursiveCounts` helper, and the test asserts the summed value. The API response stays direct so the manage page shows per-category counts.
4. **Verified: libsql cascade claim is plausible.** The plan claims `@libsql/client` enables foreign keys by default. This matches libsql's documented behavior (it differs from stock SQLite). The new PRAGMA test (ruling 2) will confirm at runtime. If it fails, the fix is to add `PRAGMA foreign_keys = ON` to `createDatabase` in `database.ts`.
5. **Verified: no em dashes or en dashes in the plan.** Grep confirmed only the convention-quoting line references the term.
6. **Verified: spec fidelity.** Routes, error codes, validation limits, cascade behavior, view filter definitions, storage key layout, and extraction failure gap all match spec sections 5, 6, 8, and review rulings 1, 2, 3, 7, 8, and edge case 6.
7. **Noted (no fix): duplicated tag-loading logic.** `documents.repository.ts`'s `loadTagsByDocument` reimplements the same query as `tags.repository.ts`'s `listTagsForDocuments`. Acceptable per the cross-module import pattern; can be refactored later.
8. **Noted (no fix): CategoryForm parent picker does not filter descendants.** Selecting a descendant as parent triggers a server 400 (categories.invalid_parent), which is caught and toasted. Adding client-side descendant filtering would be a nice-to-have but is not needed for correctness.
