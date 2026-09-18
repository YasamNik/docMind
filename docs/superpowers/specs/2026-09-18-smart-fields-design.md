# Smart fields (feature item #13): design

Status: reviewed and revised, 2026-09-18. Ready for an implementation plan.
Approved by the user on 2026-09-18 as the next item, including the new table.
Revised after `plan-reviewer` review: see "Review rulings" at the end.

## Goal

Every document carries facts that matter more than its full text: what kind of document
it is, who the other party is, how much it is for, when it is due. Today only
`documentDate` is extracted. Smart fields generalizes that: a small, controlled set of
extracted facts per document, stored so the library can filter on them.

## Not in scope

- Renewals and expiries (item #32). Smart fields gives that item the dates it needs, but
  the reminders view, the expiry type, and the Telegram nudges are its own work.
- Manual editing of field values. The table carries a `source` column so manual edits fit
  later without a migration, but this item only writes `llm` rows.
- Server-side filtering by field value. Filtering is client-side, see "Client".
- Per-field rules or sorting decisions. Fields are extracted facts, not rule outputs.

## Decisions

### Fold extraction into the existing summary call

The summary job already sends the document name and the first 8000 characters of text to
the rules model slot and already returns `documentDate` in that one reply. Smart fields
extends the same reply with a `fields` array instead of adding a second call.

Reasoning: a separate call would double the per-document LLM cost for the same input text,
and `CLAUDE.md` is explicit about sorting cost. The precedent is set by `documentDate`,
which is extracted this way today.

Cost of the choice: the summary prompt grows and its reply schema gets more complex, so a
weak model has more to get wrong in one response. This is a real quality risk to the
summary and title, not only to the fields, and it is checked manually, see "Testing".

### The reply schema stays loose, semantic checks happen after parsing

This is the most important implementation constraint in this spec.

`aiService.generateStructured` runs a single `v.safeParse` against the whole reply schema
and throws `ai.invalid_response` on any failure anywhere inside it
(`apps/server/src/modules/ai/ai.usecases.ts:155`). `summary.usecases.ts` catches that,
reverts `summaryStatus` to `pending`, and rethrows so the job retries; after the retries
the document ends up with no summary, no title, and no `documentDate` either.

So if the `fields` item schema enforced the key vocabulary or the `documentType` enum at
the valibot level, one hallucinated key would throw away the whole summary. The schema
handed to `generateStructured` therefore uses `key: v.string()` and `value: v.string()`
with no picklist, exactly as the rules engine does: `rules.schemas.ts:6` deliberately
types `id` as a plain string rather than a real tag id, and `rules.usecases.ts` checks it
after parsing and filters unknown ids out without throwing.

Every semantic check (is this a known key, is this a valid `documentType`, does this date
parse, is this amount numeric) lives in `fields.models.ts` and runs on the parsed output,
dropping only the offending row.

### A controlled key vocabulary in a flexible table

Keys come from a fixed list the prompt names explicitly. Values go into a generic
`document_fields` table keyed by `(documentId, key)`. "Controlled" is enforced in
`fields.models.ts` after parsing, never in the reply schema.

Reasoning: free-form keys give the model room to invent `vendor`, `supplier`, and
`seller` for the same fact, which makes a filter menu useless. Fixed columns on
`documents` would mean a migration for every new field. The controlled list keeps filters
meaningful now; the generic table means adding a key later is a prompt change, not a
schema change.

| Key | Meaning | Value shape |
|-----|---------|-------------|
The set is deliberately generic rather than per domain. Across business, household,
travel, bills, and receipts the same fact wears different names: vendor, merchant,
airline, landlord, clinic, and insurer are all the counterparty; invoice number, booking
reference, policy number, and passport number are all the reference number; warranty end,
coverage end, lease end, and passport expiry are all the expiry date. Naming each variant
separately would put forty keys in the prompt of every document, so a grocery receipt
would be asked about lease terms and flight numbers. Fourteen generic keys cover the same
ground with a prompt that stays short and a filter menu that stays usable.

| Key | Meaning | Value shape |
|-----|---------|-------------|
| `documentType` | What kind of document this is | one of the enum below |
| `counterparty` | The other organisation or person: vendor, merchant, airline, landlord, clinic, insurer, employer. See the rule of thumb below | text |
| `personName` | The person the document is about: patient, traveller, passport holder, insured, employee | text |
| `amountTotal` | The headline amount, the total rather than a line item | number, plus `currency` on the same row |
| `taxAmount` | VAT, GST, or sales tax, when stated separately from the total | number, plus `currency` on the same row |
| `paymentMethod` | How it was paid, masked form only | text |
| `status` | Only when the document states it | one of the status enum below |
| `accountNumber` | An account that persists across documents, such as a utility or bank account | text |
| `referenceNumber` | This document's own identifier: invoice number, booking reference, policy number, passport number | text |
| `dueDate` | When payment or action is due | date |
| `expiryDate` | When the document or its coverage stops being valid | date |
| `periodStart` | Start of the period the document covers | date |
| `periodEnd` | End of the period the document covers | date |
| `location` | Property address, travel destination, or place of service | text |

`periodStart` and `periodEnd` are the pair that earns its keep across domains: a billing
period, a hotel stay, a lease term, an insurance year, and a tax year are all the same
shape.

`documentType` enum: `invoice`, `receipt`, `utility`, `statement`, `contract`, `lease`,
`insurance`, `identity`, `medical`, `tax`, `payslip`, `travel`, `warranty`,
`subscription`, `legal`, `vehicle`, `letter`, `report`, `other`.

`status` enum: `paid`, `unpaid`, `overdue`, `confirmed`, `cancelled`, `active`, `expired`.

### Personal data in extracted fields

`personName`, `accountNumber`, and `paymentMethod` are the keys that routinely hold
personal data, which is why the prompt is explicit about masking: record `card ending
4821`, never a full card number, and never a full social insurance, social security, or
national tax identifier. Values are capped at 200 characters, so a model that ignores the
instruction still cannot dump a page of text into the row. These fields live in the same
database as the document text they came from, so the point is to avoid multiplying copies
of a card number, not to defend a new trust boundary.

Counterparty rule of thumb, stated in the prompt so the model is consistent: the party
that is not the document's owner. For a received document that is the sender, vendor, or
issuer. For a document the owner wrote, it is the addressee. If the document has no
second party, omit the field.

`documentDate` stays a column on `documents`. It is already extracted, sorted on, and
filtered on by the library, and moving it would be a migration and a client change for no
gain. Smart fields adds the dates that are not "when was this written".

### Amount and currency are one row

An amount row carries its own `currency` column. There is no separate `currency` key.

Reasoning: the table already gives typed columns to a subset of keys (`value_number`,
`value_date`), so `currency` fits that established shape. The unique index on
`(document_id, key)` means there is at most one row per amount key, so the pairing is
unambiguous and `amountTotal` and `taxAmount` can differ in currency without ambiguity.
A separate currency key would risk an orphan currency with no amount when per-row
validation drops one but not the other.

## Data model

New table `document_fields`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | text, PK | |
| `user_id` | text, not null | matches the pattern on `documents` |
| `document_id` | text, not null | FK to `documents.id`, on delete cascade |
| `key` | text, not null | one of the controlled keys |
| `value` | text, not null | display form, always present |
| `value_number` | real, nullable | set for `amountTotal` and `taxAmount` |
| `value_date` | text, nullable | YYYY-MM-DD, set for `dueDate`, `expiryDate`, `periodStart`, `periodEnd` |
| `currency` | text, nullable | ISO 4217, set on the amount rows |
| `confidence` | real, nullable | 0 to 1 as reported by the model |
| `source` | text, not null | `llm` now, `manual` later |
| `created_at` | text, not null | |
| `updated_at` | text, not null | |

Indexes:

- unique on `(document_id, key)`, so re-running extraction replaces rather than duplicates
- `(user_id, key)` for the distinct value menu

No `(user_id, key, value_date)` index. Nothing in this item filters by date range on the
server; item #32 adds it when it needs it.

Cascade delete from `documents.id` follows `document_tags` (`tags.tables.ts:54`) and
`sort_evaluations` (`rules.tables.ts:8`), which already cascade from documents directly.

Migration: `0013_add_document_fields`, generated with
`pnpm db:generate --name add_document_fields` in the same task that adds
`fields.tables.ts`, per `.claude/rules/schema-changes.md`. The code reviewer must confirm
the migration file exists before that commit lands.

## Module layout

A new self-contained module, `apps/server/src/modules/fields/`:

- `fields.tables.ts` - the Drizzle table
- `fields.types.ts` - `ExtractedField`, `FieldKey`
- `fields.schemas.ts` - the loose reply schema and the HTTP input schemas
- `fields.models.ts` - pure logic: the key vocabulary, the prompt fragment, and
  `normalizeFieldRow`, which turns one parsed model row into a storable row or rejects it
- `fields.repository.ts` - Drizzle access: replace all rows for a document, list by
  document, list distinct values per key
- `fields.routes.ts` - the read endpoints and the backfill endpoint

The summary module calls `fields.models` for the prompt fragment and the normalizing, and
the summary usecase writes rows through `fields.repository` in the same transaction that
saves the summary. The fields module never touches jobs.

## Data flow

1. Extraction finishes and enqueues the summarize job, unchanged.
2. The summary prompt also asks for a `fields` array of `{ key, value, currency,
   confidence }`, all loosely typed.
3. The reply is validated as one object. `summary`, `suggestedTitle`, and `documentDate`
   behave exactly as today.
4. Each field row goes through `normalizeFieldRow`. An unknown key, a `documentType`
   outside the enum, an unparseable date, or a non-numeric amount drops that row and logs
   it at debug with the document id and the key. A dropped row never fails the summary.
5. The usecase writes the summary columns and replaces the document's field rows in one
   transaction, so a document is never seen with half its fields.
6. Re-running summary for a document replaces its fields, which is what the unique index
   on `(document_id, key)` is for.

## Backfill

Documents summarized before this lands have no fields.

There is no existing way to re-run a completed summary. `jobsService.retry` refuses any
job that is not `failed` (`jobs.usecases.ts:51`), and the summary module has no rerun
route. Backfill is therefore new usecase code, not reuse of an existing path.

- `POST /api/fields/backfill` lives in `fields.routes.ts` but delegates to a new
  `summaryService.enqueueBackfill({ userId })`. Fields stays job-agnostic; summary owns
  the job, consistent with the module boundary above.
- The query targets documents with `extractionStatus = 'done'`, not deleted, and zero rows
  in `document_fields`. It must not re-summarize documents that already have fields, which
  after this ships is every newly uploaded document.
- It skips any document that already has a `pending` or `processing` summarize job,
  following the `findActiveJob` guard in `extraction.usecases.ts:196`, so a double click
  does not buy two LLM calls.
- The UI states the number of documents and that each costs one model call, and asks for
  confirmation before starting.

## API

- `GET /api/documents/:id/fields` - the field rows for one document
- `GET /api/fields/values?key=...` - distinct values for a key, for the filter menu,
  excluding documents in Trash so the menu matches the library
- `POST /api/fields/backfill` - as above

The document list response gains a `fields` array per document, joined the way tags and
category already are, so the library filters without an N+1 call.

## Client

- Document detail shows a definition list of the fields that are present, under the
  summary. It excludes `documentDate`, which the page already renders separately
  (`DocumentDetailPage.tsx:283`), so the same date is not shown twice under two names.
- `documentType` renders labelled "Type" and styled distinctly from the user's own
  category, which is labelled "Category". The two taxonomies overlap by nature and must
  not read as duplicates of each other.
- `confidence` shows as a tooltip on the field value, following the rules engine's
  precedent of keeping the model's certainty visible rather than hidden.
- The documents table gains a key/value filter in the column header area, consistent with
  the existing category and tag dropdowns. It filters client-side against the `fields`
  array already in each row, the same way the Added and Doc Date filters work today
  (`DocumentsPage.tsx:204`). No server round trip, and no repository filter method.
- Amounts render with their currency. Dates render through `formatDocumentDate`.

## Error handling

- A reply with no `fields` key is valid and means no fields were found.
- A row that fails normalizing is dropped with a debug log. The summary still succeeds.
- If the fields write fails, the transaction rolls back and the job retries through the
  existing path, so a document never ends up with a summary and no fields.
- `summaryStatus` stays the single status for this step. Smart fields adds no second
  status column, because it is part of the same call and cannot fail on its own.

## Testing

- `fields.models.test.ts`, unit: normalizing a good row of each type; dropping an unknown
  key; dropping a bad `documentType`; dropping an unparseable date; dropping a
  non-numeric amount; currency kept on the amount row; the prompt fragment names every
  key.
- `fields.repository.test.ts`, integration on in-memory SQLite: replace is idempotent for
  the same key; cascade delete removes rows with the document; distinct values exclude
  trashed documents.
- `summary.usecases.test.ts`, extended: a reply with fields writes rows; a reply with one
  bad row writes the good rows and still marks the summary done; a re-run replaces rather
  than duplicates.
- `fields.routes.test.ts`: the three endpoints, including that one user cannot read
  another user's fields.
- Backfill: only documents without fields are enqueued; a document with an active
  summarize job is skipped.
- Client: document detail renders present fields and omits absent ones; the table filter
  narrows the list.
- Manual, not automated: after the prompt grows, spot-check summary and title quality on
  10 to 20 real documents against what the same documents produced before. The risk that
  a busier prompt degrades the summary cannot be unit tested.

## Review rulings

From the `plan-reviewer` pass on 2026-09-18, all verified against the code before being
accepted:

- Blocker, fixed: the reply schema must stay loose or one bad field destroys the whole
  summary. Confirmed at `ai.usecases.ts:155`.
- Major, fixed: the claim that a summary rerun already existed was false. Confirmed at
  `jobs.usecases.ts:51`.
- Major, fixed: the backfill trigger's job logic belongs to summary, not fields.
- Major, fixed: backfill must skip documents that already have fields.
- Major, fixed: amount and currency are one row, not two.
- Minor, fixed: client-side filtering, no date-range index or repository filter method,
  `subscription` added to the enum, cascade citation corrected, `documentDate` excluded
  from the detail list, confidence surfaced as a tooltip, trashed documents excluded from
  the value menu, duplicate-job guard on backfill, manual quality spot-check added.

## Vocabulary widened, 2026-09-18

The user asked for more extracted data, covering business, household, travel, bills, and
receipts. Two rulings came out of that:

- The vocabulary went from six keys to fourteen, but stayed generic rather than growing a
  branch per domain. The rejected alternatives were type-specific field groups in the same
  prompt (around thirty keys, a longer prompt on every document) and a two stage classify
  then extract pipeline (the most accurate and the richest, at two model calls per
  document instead of one). The user chose the single generic set, so extraction still
  costs nothing beyond the summary call that already runs.
- Typed storage was confirmed: amounts also land in `value_number` and dates in
  `value_date`, so totalling a year of bills or finding everything expiring within thirty
  days does not mean parsing strings in SQL. Item #32 would otherwise have to add it back.

## Open question for the user, not blocking

`DocumentsPage` already fetches the whole document library unpaginated and sorts and
filters it in the browser. Adding a `fields` array per document makes each row bigger and
so brings that existing limit closer. It is fine for a personal library now. Pagination is
its own item when the library gets large enough to feel it.
