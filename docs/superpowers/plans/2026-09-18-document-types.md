# Document types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `documentType` enum with a user-curated list of types, each with a plain language description, decided by the existing sorting engine as a third dimension beside tags and categories.

**Architecture:** A new `document_types` table mirrors `tags`. Two new columns on `documents` mirror the `category_id` / `category_source` pair. The rules engine gains a third `TargetType`, so types inherit thresholds, reasoning, dry run, rerun, and correction learning. Presets and the migration of already-extracted types run lazily per user, not at server start.

**Tech Stack:** Hono, TypeScript, Drizzle over libsql (SQLite), valibot, vitest. Client: React, Vite, Tailwind, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-18-document-types-design.md`. Read it in full before starting. It names every file that has to change and why, and the review rulings at the end explain the non-obvious decisions.

## Global Constraints

- **No em dashes anywhere.** Code, comments, docs, commit messages, UI copy.
- **LLM reply schemas stay loose; HTTP and job input schemas stay strict.** `generateStructured` parses the whole reply in one pass and throws on any nested failure (`ai.usecases.ts:155`). This is the single rule most likely to be got wrong. `rules.schemas.ts:5`'s `type` discriminator becomes `v.string()` with a post-parse check; the `targetType` picklists in `rulesJobPayloadSchema`, `runScopeBodySchema`, and `dryRunBodySchema` are HTTP and job input, so they stay picklists and simply gain `"type"`.
- Valibot at every boundary. Models pure, no IO. Routes never touch Drizzle. Repositories only Drizzle.
- After changing any `*.tables.ts`, generate the migration in the SAME task (`.claude/rules/schema-changes.md`).
- Conventional commits, each ending with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FYVyGAQfZv4mTwFKfyubXK
  ```
- Verify with `pnpm --filter @docmind/server test`, `pnpm --filter @docmind/client test`, `pnpm typecheck`.

## File Structure

Types live in the existing `tags` module, which already owns both tags and categories. Do not create a `types` module: the sorting engine loads all three together and splitting them would mean a circular dependency.

| File | Change |
|------|--------|
| `apps/server/src/modules/tags/tags.tables.ts` | add `documentTypesTable` |
| `apps/server/src/modules/tags/tags.types.ts` | add `DocumentType`, `NewDocumentType`, `DocumentTypeWithCount` |
| `apps/server/src/modules/tags/tags.models.ts` | add `newDocumentTypeId`, `DOCUMENT_TYPE_PRESETS` |
| `apps/server/src/modules/tags/tags.repository.ts` | type CRUD, `clearTypeOnDocuments`, `countDocumentsByType` |
| `apps/server/src/modules/tags/tags.usecases.ts` | type CRUD, `ensureTypesSeeded`, `setDocumentType` |
| `apps/server/src/modules/tags/tags.schemas.ts` | type input schemas |
| `apps/server/src/modules/tags/tags.routes.ts` | type routes, `setDocumentType` route |
| `apps/server/src/modules/documents/documents.tables.ts` | `documentTypeId`, `documentTypeSource` |
| `apps/server/src/modules/documents/documents.repository.ts` | type filter, type name on rows |
| `apps/server/src/modules/documents/documents.schemas.ts` | filter and response fields |
| `apps/server/src/modules/rules/rules.types.ts` | `TargetType`, `ProposalKind` |
| `apps/server/src/modules/rules/rules.schemas.ts` | loose discriminator, strict input picklists |
| `apps/server/src/modules/rules/rules.models.ts` | types block in the prompt, at most one type |
| `apps/server/src/modules/rules/rules.usecases.ts` | load, apply, enrich, list for the third type |
| `apps/server/src/modules/fields/fields.types.ts`, `fields.models.ts` | remove `documentType` |
| `apps/client/src/lib/fields-format.ts` | remove `documentType` |
| `apps/client/src/pages/types/TypesPage.tsx` | new page |
| `apps/client/src/pages/documents/DocumentsPage.tsx` | Type column and filter |
| `apps/client/src/pages/documents/DocumentDetailPage.tsx` | show type beside category |
| `apps/client/src/pages/sorting/SortingPage.tsx` | `automaticItemsFrom` takes types |

---

### Task 1: The document_types table, the documents columns, and the migration

**Files:**
- Modify: `apps/server/src/modules/tags/tags.tables.ts`, `tags.types.ts`
- Modify: `apps/server/src/modules/documents/documents.tables.ts`
- Create: `apps/server/drizzle/0014_add_document_types.sql` (generated)
- Test: `apps/server/src/modules/database/database.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `database.test.ts`:

```ts
  it("creates the document_types table and the documents type columns", async () => {
    const { db } = await createTestDatabase();
    const tables = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'document_types'`,
    );
    expect(tables.length).toBe(1);
    const columns = await db.all<{ name: string }>(sql`pragma table_info(documents)`);
    const names = columns.map((c) => c.name);
    expect(names).toContain("document_type_id");
    expect(names).toContain("document_type_source");
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server test -- database.test.ts`
Expected: FAIL, `expected 0 to be 1`.

- [ ] **Step 3: Add the table**

In `tags.tables.ts`, following `tagsTable` exactly (read it first and copy its shape):

```ts
export const documentTypesTable = sqliteTable(
  "document_types",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color"),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.7),
    autoApply: integer("auto_apply").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("document_types_user_idx").on(t.userId),
    uniqueIndex("document_types_user_name_idx").on(t.userId, sql`${t.name} COLLATE NOCASE`),
  ],
);
```

- [ ] **Step 4: Add the documents columns**

In `documents.tables.ts`, beside `categoryId` and `categorySource`:

```ts
    documentTypeId: text("document_type_id"),
    documentTypeSource: text("document_type_source"),
```

- [ ] **Step 5: Add the types**

In `tags.types.ts`, mirroring the `Tag` types already there:

```ts
export type DocumentType = typeof documentTypesTable.$inferSelect;
export type NewDocumentType = typeof documentTypesTable.$inferInsert;
export type DocumentTypeWithCount = Omit<DocumentType, "autoApply"> & { autoApply: boolean; documentCount: number };
```

- [ ] **Step 6: Generate the migration**

From `apps/server`: `pnpm db:generate --name add_document_types`

Open `apps/server/drizzle/0014_add_document_types.sql` and confirm it creates `document_types` with both indexes and adds exactly two columns to `documents`, with no unrelated ALTER TABLE. If other tables appear, the snapshot has drifted (this bit the project at 0006, see `docs/bugs_fix_tracking.md`): STOP and report rather than committing it.

- [ ] **Step 7: Run the test and watch it pass**

Run: `pnpm --filter @docmind/server test -- database.test.ts`

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/tags apps/server/src/modules/documents/documents.tables.ts apps/server/drizzle apps/server/src/modules/database/database.test.ts
git commit -m "feat(server): add document_types table and documents type columns"
```

---

### Task 2: Presets, seeding, and the one time data migration

**Files:**
- Modify: `apps/server/src/modules/tags/tags.models.ts` (presets, id helper)
- Modify: `apps/server/src/modules/tags/tags.repository.ts`
- Modify: `apps/server/src/modules/tags/tags.usecases.ts`
- Test: `apps/server/src/modules/tags/tags.models.test.ts`, `tags.usecases.test.ts`

**Interfaces:**
- Produces: `DOCUMENT_TYPE_PRESETS`, `newDocumentTypeId()`, `tagsService.ensureTypesSeeded({ userId })`

Read the spec's "Seeding and the one time data migration" section before writing any of this. The two non-obvious constraints: seeding must NOT run at server start, and preset insertion must be collision tolerant per preset because the guard flag cannot commit in the same transaction.

- [ ] **Step 1: Write the failing tests**

In `tags.usecases.test.ts`:

```ts
  it("seeds the preset types once", async () => {
    const t = await setup();
    await t.services.tagsService.ensureTypesSeeded({ userId: t.userId });
    await t.services.tagsService.ensureTypesSeeded({ userId: t.userId });
    const types = await t.services.tagsService.listTypes(t.userId);
    expect(types).toHaveLength(DOCUMENT_TYPE_PRESETS.length);
    expect(types.map((x) => x.name)).toContain("Identity");
  });

  it("does not resurrect a preset the user deleted", async () => {
    const t = await setup();
    await t.services.tagsService.ensureTypesSeeded({ userId: t.userId });
    const identity = (await t.services.tagsService.listTypes(t.userId)).find((x) => x.name === "Identity")!;
    await t.services.tagsService.deleteType({ userId: t.userId, typeId: identity.id });
    await t.services.tagsService.ensureTypesSeeded({ userId: t.userId });
    expect((await t.services.tagsService.listTypes(t.userId)).map((x) => x.name)).not.toContain("Identity");
  });

  it("keeps the user's own type when a preset wants the same name", async () => {
    const t = await setup();
    await t.services.tagsService.createType({ userId: t.userId, name: "Receipt", description: "Mine" });
    await t.services.tagsService.ensureTypesSeeded({ userId: t.userId });
    const receipts = (await t.services.tagsService.listTypes(t.userId)).filter((x) => x.name.toLowerCase() === "receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.description).toBe("Mine");
  });

  it("moves an already extracted documentType field onto the document and removes the field row", async () => {
    // Seed a document with a document_fields row key documentType value "invoice",
    // then call ensureTypesSeeded and assert documents.documentTypeId points at the
    // Invoice preset, documentTypeSource is "rule", and the field row is gone.
  });

  it("maps the retired utility value onto Bill and leaves other with no type", async () => {
    // Two documents, one with value "utility" and one with "other".
  });
```

Write the last two out fully against the real harness; read how `summary.usecases.test.ts` seeds a document and a field row and copy that.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- tags.usecases`
Expected: FAIL, `ensureTypesSeeded is not a function`.

- [ ] **Step 3: Add the presets and the id helper**

In `tags.models.ts`. The eighteen presets and their exact descriptions are in the spec's "Preset types" table; copy them verbatim, they are written for the model to read.

```ts
export const DOCUMENT_TYPE_PRESETS: { name: string; description: string }[] = [
  { name: "Identity", description: "Proves who someone is. Passport, driving licence, national ID card, residence permit, visa." },
  // ... the remaining seventeen, verbatim from the spec
];

// Maps the retired smart fields enum onto the presets. `other` is deliberately absent:
// a document that matched nothing keeps no type at all.
export const RETIRED_TYPE_VALUE_MAP: Record<string, string> = {
  invoice: "Invoice",
  receipt: "Receipt",
  utility: "Bill",
  statement: "Statement",
  contract: "Contract",
  lease: "Lease",
  insurance: "Insurance",
  identity: "Identity",
  medical: "Medical",
  tax: "Tax",
  payslip: "Payslip",
  travel: "Travel",
  warranty: "Warranty",
  subscription: "Subscription",
  legal: "Legal",
  vehicle: "Vehicle",
  letter: "Letter",
  report: "Report",
};
```

Add `newDocumentTypeId()` beside `newTagId`, with a `dtype_` prefix.

- [ ] **Step 4: Add the repository methods**

Mirror the tag methods: `listTypesRaw`, `findTypeById`, `insertType`, `updateType`, `deleteType`, `countDocumentsByType`, `clearTypeOnDocuments`. All take an optional `tx = db` like the existing ones.

Add one for the migration: `listDocumentTypeFieldRows({ userId })` returning the `document_fields` rows with `key = 'documentType'`, and `deleteDocumentTypeFieldRows({ userId, tx })`.

- [ ] **Step 5: Implement ensureTypesSeeded**

```ts
  // Not called at server start. A fresh install has no user at boot: sign up closes
  // after the first account and happens once the process is already serving, so a boot
  // time step would find nobody and never run again. Callers pass a real userId.
  async function ensureTypesSeeded({ userId }: { userId: string }) {
    const done = await settingsService.getInternal(userId, "types.presetsSeeded");
    if (done) return;

    // Inserted one at a time, not as a batch. The guard flag cannot commit in the same
    // transaction as these rows, because the settings repository takes no tx, so a crash
    // between the inserts and the flag has to leave a retry able to finish. A name the
    // user already owns is skipped, never overwritten.
    for (const preset of DOCUMENT_TYPE_PRESETS) {
      try {
        await repository.insertType({ ...buildType(userId, preset) });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          logger.info({ userId, name: preset.name }, "Preset type skipped, the name is already taken");
          continue;
        }
        throw error;
      }
    }

    await migrateExtractedTypes({ userId });
    await settingsService.setInternal(userId, "types.presetsSeeded", true);
  }
```

`migrateExtractedTypes` reads the field rows, resolves each value through
`RETIRED_TYPE_VALUE_MAP` to a type id, and in ONE transaction writes
`documentTypeId` / `documentTypeSource = "rule"` on each document and deletes the field
rows. An unrecognised value is logged and left alone.

- [ ] **Step 6: Call it from the two places that need types**

- the types list usecase
- wherever the rules engine loads automatic items, `rules.usecases.ts:48`

- [ ] **Step 7: Run the tests, then the whole server suite**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(server): seed preset document types and migrate extracted ones"
```

---

### Task 3: The sorting engine gains a third dimension

**Files:** `rules.types.ts`, `rules.schemas.ts`, `rules.models.ts`, `rules.usecases.ts`, and their tests.

The spec's "Sorting engine changes" section lists every call site. Work through it line by line; a plan reader who only adds the enum value will miss half of them.

- [ ] **Step 1: Write the failing tests**

```ts
  it("lists every automatic type with its description in the prompt", () => { /* ... */ });
  it("tells the model a document takes at most one type", () => { /* ... */ });
  it("drops a reply row whose discriminator is not tag, category, or type", () => {
    // And asserts the good rows in the same reply still apply. This is the regression
    // test for the loosened schema.
  });
  it("applies the highest confidence type at or above its threshold", () => { /* ... */ });
  it("proposes rather than applies a type below its threshold", () => { /* ... */ });
  it("does not overwrite a manually set type on a rerun", () => { /* ... */ });
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Widen the types**

`rules.types.ts:6`: `export type TargetType = "tag" | "category" | "type";`
`rules.types.ts:9`: add `"set_type"` to `ProposalKind`.

- [ ] **Step 4: Loosen the reply discriminator, tighten nothing else**

In `rules.schemas.ts`, change `type: v.picklist(["tag", "category"])` to `type: v.string()` with a comment explaining why (see the spec). Add `"type"` to the three input picklists at lines 18, 25, 34: those are HTTP and job input, not model output, so they stay strict.

- [ ] **Step 5: Filter unknown discriminators after parsing**

This is new code. `resultsForItems` and `findUnknownReplyIds` never read `reply.type` today. Before `resultsForItems` runs, drop rows whose `type` is not one of the three, and log them beside the existing unknown id logging.

- [ ] **Step 6: Work through the remaining call sites**

`loadSingleItem`, `requireTag` / `requireCategory`, `enrichProposals`,
`listEvaluationsForDocument`, the automatic item loading at line 48, the prompt blocks in
`rules.models.ts`, and the apply paths. Each is a two branch function that needs a third.

- [ ] **Step 7: Run the whole server suite**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(server): sort documents into types alongside tags and categories"
```

---

### Task 4: Type routes and setting a type by hand

**Files:** `tags.schemas.ts`, `tags.routes.ts`, `tags.usecases.ts`, `tags.routes.test.ts`

- [ ] **Step 1: Write the failing tests**

CRUD, duplicate name rejected with 409 (mirroring `tags.duplicate_name`), deleting a type clears it from its documents, and `setDocumentType` records a correction the way the category route does at `tags.routes.ts:110`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Mirror the tag and category routes exactly. `setDocumentType` mirrors
`setDocumentCategory` (`tags.usecases.ts:310-327`) and calls
`recordCorrection({ targetType: "type", ... })`.

- [ ] **Step 4: Run the suite and commit**

```bash
git commit -m "feat(server): document type routes and manual type setting"
```

---

### Task 5: Documents list and detail plumbing

**Files:** `documents.repository.ts`, `documents.schemas.ts`, `documents.usecases.test.ts`

- [ ] **Step 1: Write the failing test**

The list response carries the type id and name, and a `documentTypeId` filter narrows the list.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Mirror the category plumbing at `documents.repository.ts:33-34,65,113-128,147,189` and
`documents.schemas.ts:17,44`. Simpler than categories: no hierarchy, so no path building,
just the type's name resolved onto each row.

- [ ] **Step 4: Run the suite and commit**

```bash
git commit -m "feat(server): filter and return document type on document payloads"
```

---

### Task 6: Remove documentType from smart fields

**Files:** `fields.types.ts`, `fields.models.ts`, `fields-format.ts`, and the five test files named in the spec.

Do this AFTER Task 2, so the data migration has already moved the values somewhere safe.

- [ ] **Step 1: Remove the key**

Server: `FIELD_KEYS` at `fields.types.ts:7`, the `DOCUMENT_TYPES` constant at
`fields.types.ts:25-45`, the branch at `fields.models.ts:103-107`, and the prompt line.
Client: `fields-format.ts:6-21`, `FIELD_KEY_LABELS.documentType` at line 28, and
`CAPITALIZED_KEYS` at line 47.

- [ ] **Step 2: Update the five test files that reference it**

`summary.usecases.test.ts:48,137,146,158`, `DocumentDetailPage.test.tsx:253`,
`DocumentsPage.test.tsx:34,80`, `SortingPage.test.tsx:117`. Update them honestly to match
the thirteen key vocabulary; do not delete coverage.

- [ ] **Step 3: Run both suites and commit**

```bash
git commit -m "refactor: document type leaves the smart fields vocabulary"
```

---

### Task 7: The client

**Files:** new `apps/client/src/pages/types/TypesPage.tsx` and its test, plus
`DocumentsPage.tsx`, `DocumentDetailPage.tsx`, `SortingPage.tsx`, the nav, and a
`types-api.ts`.

- [ ] **Step 1: Write the failing tests**

The Types page renders, creates, and saves a type. The documents table filters by type.
The detail page shows type and category as visually distinct things. The Sorting page's
automatic item count includes types.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- `TypesPage` copies `TagsPage` closely, including the `DescriptionAssistant` and
  `ColorPicker` built on 2026-09-18, and the "test on a document" dry run panel.
- Add it to the nav beside Tags and Categories.
- `DocumentsPage`: a Type column with a header filter, mirroring Category.
- `DocumentDetailPage`: type beside category, styled so the two taxonomies do not read
  as duplicates of each other.
- `SortingPage.tsx:143`: `automaticItemsFrom(tags, categories, types)`, and the empty
  state copy at line 365, which currently names only two taxonomies.

- [ ] **Step 4: Full verification**

```bash
pnpm --filter @docmind/server test
pnpm --filter @docmind/client test
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(client): types page, type column, and type in the sorting count"
```

---

## Before calling this done

- Run a sort over a handful of real documents and check the types chosen are sensible,
  and that the reasoning stored against each one reads as a real justification.
- Confirm the automatic item count on the Sorting page went up by the number of
  automatic types, since that counter is the only cost warning the user gets.
- Confirm a document that already had a type from smart fields still has it, and has no
  leftover `documentType` row in `document_fields`.
