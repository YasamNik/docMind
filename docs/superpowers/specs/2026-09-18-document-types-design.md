# Document types: design

Status: reviewed and revised, 2026-09-18. Ready for an implementation plan.
Approved by the user on 2026-09-18, including the new table, the two new columns on
`documents`, and the one time data migration.
Revised after `plan-reviewer`: see "Review rulings" at the end.

## Goal

Smart fields shipped `documentType` as a hardcoded list of nineteen values. That list is
a guess about what the user's documents look like, and the model has nothing to reason
from but the bare word `identity`.

Document types become a curated list the user owns: a name and a plain language
description, exactly like tags and categories. The sorting engine decides the type by
reading those descriptions, so the user can teach it what a type means in their own
words and add types DocMind never anticipated.

## Decision: types are a third dimension of the sorting engine

The rules engine already does this job. `rules.models.ts:23` describes its input as "a
list of the user's tags and categories, each with a plain language description written
by the user", it judges each item "only against the item's description"
(`rules.models.ts:28`), and it already enforces "any number of tags but at most one
category" (`rules.models.ts:32`). A document type is the same shape as a category: one
per document, chosen from a described list.

Adding types there inherits, with no new machinery: confidence thresholds, the automatic
toggle, stored reasoning, dry run, re-evaluation, correction learning (item #24), and
rule suggestions (item #25).

Deciding the type in the summary call instead was rejected: it would need its own
threshold, reasoning storage, and rerun path built from scratch, and it would grow a
prompt already carrying thirteen other fields.

`documentType` therefore leaves the smart fields vocabulary, which drops from fourteen
keys to thirteen. Two systems deciding the same fact would eventually disagree.

## Decision: loosen the rules reply schema while adding the third value

`rules.schemas.ts:5` types the reply's discriminator as
`type: v.picklist(["tag", "category"])`. That is a strict enum inside an LLM reply
schema, and `generateStructured` parses the whole reply in one pass and throws on any
nested failure (`ai.usecases.ts:155`), so a model answering `"types"` or
`"document_type"` discards every tag and category decision for that document. The `id`
field directly below it is deliberately a plain `v.string()` for this reason.

This changes to `type: v.string()`. Rows whose discriminator is not one of the three
known values are dropped after parsing and logged.

Note for the implementer: this filter is **new code**. `resultsForItems` and
`findUnknownReplyIds` (`rules.models.ts:108-120`) key purely on `item.id` and never read
`reply.type` today, so there is no existing discriminator filtering to extend. Drop the
bad rows before `resultsForItems` runs. Losing one row costs that one item's decision
for that one document, never the rest of the reply.

## Data model

New table `document_types`, mirroring `tags`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | text, PK | `dtype_` prefix, matching the `tag_` and `cat_` convention |
| `user_id` | text, not null | |
| `name` | text, not null | unique per user, case insensitive, as tags are |
| `description` | text, not null, default "" | what the sorting engine reads |
| `color` | text, nullable | |
| `confidence_threshold` | real, not null, default 0.7 | |
| `auto_apply` | integer, not null, default 1 | 0/1, as on tags |
| `created_at` | text, not null | |
| `updated_at` | text, not null | |

Indexes: `(user_id)`, and a unique index on `(user_id, name COLLATE NOCASE)`, copying
`tags_user_name_idx`.

Two new columns on `documents`, mirroring the existing category pair:

| Column | Type | Notes |
|--------|------|-------|
| `document_type_id` | text, nullable | the chosen type |
| `document_type_source` | text, nullable | `rule` or `manual`, as `category_source` is |

No foreign key, matching how `category_id` is declared today. Deleting a type therefore
clears it from its documents in the same transaction, exactly as `deleteCategory`
already does (`tags.usecases.ts:269-278`).

`sort_evaluations.target_type` and `rule_examples.target_type` are plain text columns
(`rules.tables.ts:11`, `rules.tables.ts:37`), so they accept `type` with no schema
change.

Migration `0014_add_document_types`, generated in the same task that adds the tables
file, per `.claude/rules/schema-changes.md`.

## Preset types

| Name | Description |
|------|-------------|
| Identity | Proves who someone is. Passport, driving licence, national ID card, residence permit, visa. |
| Receipt | Proof of a purchase already paid, usually itemised, issued at the point of sale. |
| Bill | A request for payment for a service over a period, such as electricity, water, gas, phone, or internet. |
| Invoice | A request for payment for goods or work, usually carrying an invoice number and a due date. |
| Statement | A periodic account summary from a bank, card issuer, or broker. Lists transactions rather than asking for payment. |
| Contract | A signed agreement setting out obligations between two or more parties. |
| Lease | A rental agreement for a property or vehicle, with a term and a rent amount. |
| Insurance | A policy, certificate, schedule, or renewal notice for cover of any kind. |
| Medical | Anything from a clinic, hospital, doctor, dentist, or pharmacy: results, prescriptions, referrals, discharge notes. |
| Tax | Anything issued by or addressed to a tax authority, including returns, assessments, and tax certificates. |
| Payslip | A record of pay for one period, showing gross pay, deductions, and net pay. |
| Travel | A booking, ticket, itinerary, or boarding pass for a trip. |
| Warranty | A guarantee covering a product for a period after purchase. |
| Subscription | A confirmation or renewal notice for a recurring paid service. |
| Legal | Correspondence or filings from a lawyer, a court, or a government legal body. |
| Vehicle | Registration, title, service record, or inspection for a car, motorcycle, or other vehicle. |
| Letter | General correspondence that does not fit another type. |
| Report | An analysis or set of findings, such as an inspection, survey, or assessment. |

No `Other` preset. A document that matches no type has no type, which matches how an
uncategorized document behaves today.

Presets are created with `autoApply` true, matching the default for tags and categories
(`tags.usecases.ts:113`).

## Seeding and the one time data migration

**Not at server start.** Sign-up closes after the first account and is enforced in a
`databaseHooks.user.create.before` hook (`auth.services.ts:26-34`), so on a fresh install
the single user is created minutes *after* the process began serving. A step that runs at
boot would find zero users, do nothing, and never run again until someone restarted the
container. Nothing in the codebase enumerates users, and nothing should have to.

Instead: `ensureTypesSeeded(userId)`, called from the usecases that need types, with a
real `userId` already in hand. Two call sites:

- the types list usecase, so opening the Types page seeds them
- wherever the rules engine loads automatic items (`rules.usecases.ts:48`), so a sort run
  seeds them even if the page was never opened

It is guarded by an internal setting `types.presetsSeeded`, using the existing pattern
(`defineSetting({ internal: true })` at `settings.registry.ts:11`, `setInternal` at
`settings.usecases.ts:170`).

**Preset insertion is collision tolerant, per preset, rather than atomic with the
guard.** `settingsRepository.upsert` and `remove` take no `tx` parameter
(`settings.repository.ts:10,20`), unlike every other repository here, so the guard flag
cannot commit in the same transaction as the inserts without changing the settings
module. Rather than widen the settings module for this, each preset is inserted
individually and a unique name collision is skipped and logged, not fatal.

That choice buys two things beyond crash safety:

- If the process dies after inserting but before setting the flag, the retry skips what
  is already there instead of dying on `SQLITE_CONSTRAINT` forever.
- If the user has already created a type named `Receipt` before seeding runs, their row
  wins and the preset is skipped. Their definition is not silently overwritten.

The same guarded step then performs the data migration:

1. Seed the presets.
2. Read every `document_fields` row with `key = 'documentType'`.
3. Map its value to the seeded type and write `documents.document_type_id` with
   `document_type_source = 'rule'`.
4. Delete those `document_fields` rows.

Mapping from the retired enum: `utility` maps to Bill, `other` maps to no type, every
remaining value maps to the preset of the same name. An unrecognised value is left
alone and logged rather than guessed at.

Steps 2 to 4 run in one transaction so a document is never left pointing at a type while
its old field row still exists.

## Sorting engine changes

This ripples further than "add a value to an enum". Every one of these needs the third
value or a third branch:

- `rules.types.ts:6` `TargetType`, and `rules.types.ts:9` `ProposalKind` gains `set_type`
- `rules.schemas.ts:18,25,34`: `rulesJobPayloadSchema.targetType`,
  `runScopeBodySchema.targetType`, `dryRunBodySchema.targetType` are all picklists
  hardcoded to `["tag","category"]`. These are HTTP and job input, not LLM output, so
  they stay strict picklists and simply gain the third value.
- `rules.usecases.ts:88-118`: `loadSingleItem`, `requireTag` / `requireCategory`
- `rules.usecases.ts:414-429`: `enrichProposals`
- `rules.usecases.ts:468-478`: `listEvaluationsForDocument`
- `rules.usecases.ts:48`: loading automatic items now loads types too
- `rules.models.ts`: a types block in the prompt formatted like the tags and categories
  blocks, and an at most one type instruction parallel to the existing at most one
  category rule
- the apply paths (`applyInitialResults`, `applyRerunResults`, `rules.usecases.ts:180-303`)
  and `pickCategory` / `isAppliedResult` / `outcomeFor` / `deriveRerunOutcome`
  (`rules.models.ts:122-189`), which are already generic over `AutomaticItem.type`

**A manually set type survives a rerun.** Mirroring `deriveRerunOutcome`
(`rules.models.ts:183-186`), a type whose source is `manual` is not overwritten by a
later sort. This is the same protection a manually set category has today, and it needs
its own test rather than being assumed.

## Setting the type by hand

`document_type_source` has a `manual` value, so there must be a way to produce it.
A `setDocumentType` action mirrors `setDocumentCategory` (`tags.usecases.ts:310-327`),
and like the category and tag routes (`tags.routes.ts:110,121,132`) it calls
`recordCorrection({ targetType: "type", ... })` so item #24 learns from the correction
the same way it learns from a corrected tag.

Without this the `manual` source would be unreachable and should be dropped from the
data model. It is kept, so the route is part of this work, not a follow up.

## Documents list and detail plumbing

The Type column needs server support, mirroring the category plumbing rather than only
the client:

- `documents.repository.ts:33-34,65,113-128,147,189`: the `categoryId` filter, the
  `categoryPath` join, and the resolution onto each row. Types need the equivalent, and
  are simpler because they have no hierarchy: a `documentTypeId` filter and the type's
  name resolved onto the row.
- `documents.schemas.ts:17,44`: the list filter schema and the response fields.

## Client

- A **Types** page beside Tags and Categories, with the same form: name, description,
  colour, confidence threshold, automatic toggle, and test on a document. It reuses the
  `DescriptionAssistant` and `ColorPicker` built today.
- The documents table gains a **Type** column with a header filter, matching Category.
- The document detail page shows the type beside the category, visually distinct, since
  the two taxonomies overlap by nature and must not read as duplicates.
- The extracted details list no longer shows Type.
- `SortingPage.tsx:143` `automaticItemsFrom(tags, categories)` takes types as a third
  argument, so the automatic item count the user is warned about actually includes them.
  The empty state copy at `SortingPage.tsx:365`, "No tag or category has both a
  description and automatic sorting turned on yet", is hardcoded to two taxonomies and
  needs the third.

## Smart fields changes

Remove `documentType` from:

- server `fields.types.ts:7` (`FIELD_KEYS`) and the `DOCUMENT_TYPES` constant at
  `fields.types.ts:25-45`
- `normalizeFieldRow`'s `documentType` branch, `fields.models.ts:103-107`
- the prompt section in `fields.models.ts`
- client `fields-format.ts:6-21` (`FIELD_KEYS`), `FIELD_KEY_LABELS.documentType` at
  line 28, and `CAPITALIZED_KEYS` at line 47

Thirteen keys remain.

These five existing test files reference `documentType` and need updating:
`summary.usecases.test.ts:48,137,146,158`, `DocumentDetailPage.test.tsx:253`,
`DocumentsPage.test.tsx:34,80`, `SortingPage.test.tsx:117`.

## Cost

Every automatic type description joins tags and categories in the per document sorting
prompt, which `CLAUDE.md` names as the cost driver. Eighteen one line descriptions is
cheap beside a user's existing tags. The Sorting page's automatic item count is the
warning mechanism, which is why updating `automaticItemsFrom` is part of this work
rather than a nicety.

## Testing

- Models, unit: the prompt lists every automatic type with its description; the at most
  one type instruction is present; a reply row with an unknown discriminator is dropped
  after parsing rather than throwing; highest confidence type above threshold wins; a
  type below threshold becomes a proposal.
- Repository, integration: unique name per user, case insensitive; deleting a type
  clears it from its documents in the same transaction.
- Seeding, integration: presets appear once; a second call does not duplicate them; a
  deleted preset does not return; a user's own type with a preset's name is not
  overwritten; a crash between insert and flag leaves a retry able to finish.
- Data migration, integration: an existing `documentType` field row lands on
  `documents.document_type_id`; `utility` maps to Bill; `other` leaves the type null; an
  unrecognised value is left alone; the `document_fields` rows are gone afterwards.
- Rerun: a manually set type is not overwritten by a later sort.
- Routes: CRUD, duplicate name rejected, and `setDocumentType` records a correction.
- Client: the Types page renders and saves; the documents table filters by type; the
  detail page shows type and category distinctly; the automatic item count includes
  types.
- Regression: a sorting reply containing tags, categories, and types applies all three,
  and a reply whose discriminator is misspelled still applies the good rows.

## Review rulings

From `plan-reviewer` on 2026-09-18, each verified against the code before being accepted:

- Blocker, fixed: seeding at server start cannot work. A fresh install has no user at
  boot because sign-up happens after the process is serving, so the step would never
  run. Replaced with a lazy `ensureTypesSeeded(userId)` at two call sites.
- Fixed: the guard flag cannot be atomic with the inserts, because
  `settings.repository.ts:10` takes no `tx`. Preset insertion is collision tolerant per
  preset instead, which also resolves the case where the user already owns that name.
- Fixed: the discriminator filter is new code, not an extension of existing filtering.
- Fixed: the `TargetType` and `ProposalKind` ripple is now enumerated file by file.
- Fixed: `document_type_source: 'manual'` was unreachable. A `setDocumentType` route
  with correction recording is now part of the work.
- Fixed: the Type column needs `documents.repository.ts` and `documents.schemas.ts`
  changes, not only client work.
- Fixed: `automaticItemsFrom` and the Sorting page empty state copy are hardcoded to two
  taxonomies.
- Fixed: a manually set type surviving rerun is now stated and tested.
- Confirmed: deleting a category really does clear it from its documents
  (`tags.usecases.ts:269-278`), so clearing on delete is the genuine precedent, not a
  simplification. Types follow it.
