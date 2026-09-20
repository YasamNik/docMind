# Family budget

Date: 2026-09-20
New feature. Not on the numbered feature list: the user asked for it directly.

## Why

A receipt is the one document people throw away and then wish they had. The user wants to
photograph one in the shop, have every line item read off it, categorised and counted, and
then ask where the money went this month. DocMind already reads documents. It does not yet
read the inside of a receipt.

## What the user decided

Asked and answered on 2026-09-20:

- **Item categories are a new vocabulary with their own settings page**, shaped like
  `document_types`: name, description, colour, automatic. Not the existing document
  categories, which answer a different question, namely what kind of paper this is.
- **One budget.** In the user's words: "the user is one person, but budget might be
  different, lets say home budget and business budget. but as a simple way, start with one
  family budget." Section 8 says exactly how a second one lands, and it is one column with
  a default plus a picker, not a rewrite.
- **A receipt is also an ordinary document.** Searchable, chattable, in the library, with
  the budget record pointing at it. Not a parallel filing system.
- **Several photos of one long receipt are grouped by the user** in the capture sheet.
  Nothing is detected. The user says "this is page two".
- **A suspected duplicate is flagged for the user to resolve**, never silently dropped.
- **Currency is stored per receipt, with no conversion.**

## Design

### 1. What this is built from

Almost nothing here is new machinery.

| Existing | What it contributes |
|----------|---------------------|
| `documents.upload()` | streaming upload, storage driver, and the content hash reuse that already makes re-uploading an identical file a no-op |
| `documents.parentDocumentId` | pages 2..n hang off page 1 exactly as mail attachments hang off their mail, with the same delete cascade and related-documents panel |
| `extraction` | OCR of the photos, the vision LLM fallback when OCR confidence is low, and the status-on-the-row pattern this module copies |
| `fields` | already pulls a counterparty, a total and a tax amount off any document, so a receipt is useful in search before the budget job has run |
| `tags` seeding | `ensureTypesSeeded` is the template for seeding presets lazily per user behind an internal settings flag |
| `ai.generateStructured` | the one structured call, with the loose reply schema discipline from `summary.schemas.ts` |
| `use-media-query.ts` | `useIsMobile()` already decides table versus card list; the capture sheet is the phone branch |

### 2. Three new tables

Every column the user is being asked to approve is here, in one place.

**`budget_receipts`**, one row per receipt.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text pk | |
| `user_id` | text not null | |
| `document_id` | text not null | references `documents(id)` on delete cascade. Page 1 |
| `merchant` | text | as printed, editable |
| `merchant_category` | text | one of a fixed list in code: grocery, restaurant, pharmacy, fuel, transport, clothing, electronics, home, entertainment, services, other. Null when nothing matched |
| `purchased_at` | text | YYYY-MM-DD from the receipt, not the upload time |
| `currency` | text | ISO 4217, per receipt, never converted |
| `total` | real | the printed total, what was actually paid |
| `tax_amount` | real | null unless the receipt states it separately |
| `status` | text not null default `'pending'` | `pending`, `ready`, `needs_review`, `failed` |
| `note` | text | why it needs review, or the extraction error |
| `duplicate_of_receipt_id` | text | references `budget_receipts(id)` on delete set null |
| `created_at`, `updated_at` | text not null | ISO 8601 UTC |

Indexes: `(user_id, purchased_at)` for the month list, unique `(user_id, document_id)`.

**`budget_receipt_items`**, one row per line on the receipt.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text pk | |
| `user_id` | text not null | carried like `document_fields` does, so a scoped list needs no join |
| `receipt_id` | text not null | references `budget_receipts(id)` on delete cascade |
| `line_number` | integer not null | position on the receipt, for stable order |
| `description` | text not null | as printed |
| `quantity` | real | null when the line does not say. Without it a price rise and a bigger basket look the same |
| `unit_price` | real | null when the line does not say |
| `amount` | real not null | the line total |
| `item_category_id` | text | references `budget_item_categories(id)` on delete set null |
| `category_source` | text | `auto` or `manual`, the two values `documents.category_source` already uses |
| `confidence` | real | the model's confidence in the category |
| `created_at`, `updated_at` | text not null | |

Index: `(receipt_id, line_number)`.

**`budget_item_categories`**, the new vocabulary. Deliberately the four attributes the user
named and no more. No confidence threshold column: `document_types` has one because the
sorter compares per target, and here one global floor does the job.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text pk | |
| `user_id` | text not null | |
| `name` | text not null | |
| `description` | text not null default `''` | this is the prompt text, see section 7 |
| `color` | text | |
| `auto_apply` | integer not null default 1 | off means manual only, never suggested |
| `created_at`, `updated_at` | text not null | |

Indexes: `(user_id)`, unique `(user_id, name COLLATE NOCASE)`.

**Nothing else changes in the schema.** No receipt pages table: `parent_document_id`
already links them and their capture order is their `created_at` order, derived not stored.
No items total column: it is the sum of the item rows, computed when read. No month column:
`purchased_at` is indexed and a month is a string prefix.

**Two additive, non-schema changes.** `POST /api/documents` gains an optional
`parentDocumentId` query parameter, so the capture sheet can file page 2 under page 1
through the upload path that already exists instead of getting its own upload endpoint.
`jobs.enqueue` gains an optional `availableAt`, a parameter for a column that already
exists, for the reason in section 5.

### 3. The capture flow

This is the interaction that matters. Someone is standing at a till.

1. The Budget page has one primary button, **Scan receipt**, in thumb reach on a phone. It
   is a file input with `accept="image/*"` and `capture="environment"`, which opens the
   camera directly on iOS and Android and stays an ordinary file picker on a desktop.
2. Each shot lands in a staging list in the sheet with a thumbnail and a page number.
   **Add another page** takes the next shot. Everything in the staging list is one receipt:
   that is the explicit grouping. A shot can be removed before saving.
3. **Save** uploads page 1, then each remaining page with `?parentDocumentId=<page 1>`, then
   posts `{ documentIds }` to `/api/budget/receipts`. The receipt row is created `pending`
   and a `receipt` job is enqueued.
4. The sheet closes at once and the receipt appears at the top of the month list with a
   spinner and "Reading receipt". Nobody waits in a shop, and closing the app is safe
   because the work is a job on the server.
5. It lands as `ready` or `needs_review`, with a badge saying which.

**When extraction gets it wrong**, which it will: every value is editable. Merchant, date,
total, tax, currency and merchant category on the receipt, description, quantity, amount
and category on each line, plus add a line and delete a line. One **Re-read** button
re-runs the job over the same photos for when the first pass was garbage and fixing it by
hand is more work than trying again. It discards the extracted lines, so it asks first.

### 4. Reading the line items

**One structured LLM call per receipt, on the rules slot, over OCR text.** Not a vision
call of its own: the vision fallback already fires inside extraction when OCR confidence is
below the threshold, so a bad photo is handled by the path that exists and a second image
call here would pay twice for the same picture.

The job concatenates page 1's `extracted_text` and each child's in capture order with a
page marker between them. The call returns the header values and the items, and assigns
each item a category in the same reply, see section 7.

**Too long.** The concatenated text is capped at 24000 characters. A supermarket receipt
with sixty lines is under 4000, so this is a guard, not a normal path. Over the cap, the
text is truncated there, the receipt is saved `needs_review` with a note saying so, and the
user sees what was read. No chunking, no second call. If a real receipt ever hits this,
that is the moment to design for it.

**Items that do not sum to the total** is the normal case, not the error case: discounts,
loyalty points, bottle deposits and rounding all break the sum. Neither number is ever
adjusted to fit the other. `total` is what was printed, the items are what was printed, and
their sum is derived when read. When the two differ by more than 0.02 the receipt is
`needs_review` with the difference in the note, and the detail screen shows both numbers
with the gap named. The month total counts `total`, because that is the money that left the
account. The category breakdown counts items and shows the remainder as its own row called
Unmatched rather than hiding it.

**Valibot at the boundary, loose.** The reply schema follows `summary.schemas.ts`: `items`
is `v.unknown()` and every header value is an optional loose string. `generateStructured`
parses a whole reply in one pass and throws on any nested failure, so asserting the shape
of the items array would throw away a correct merchant and total because one line came back
malformed. Every check happens after parsing, in `budget.models.ts`, dropping only the
offending row. HTTP input schemas stay strict.

### 5. When the job runs

The receipt job needs every page's text and extraction is itself a job, so it checks the
pages first: if any is still `pending` or `processing` it re-enqueues itself with
`availableAt` ten seconds out and finishes cleanly. A tries counter in the payload caps the
wait at ten minutes, after which the receipt is `failed` with a note rather than looping
forever. A page whose extraction failed is skipped and named in the note: three good pages
out of four still make a useful receipt.

### 6. Duplicates

Two receipts are the same when all four of these match: merchant compared
case-insensitively and trimmed, `purchased_at`, `total`, and `currency`. Nothing fuzzy, no
tolerance on the total, no time window. A confident rule that occasionally misses beats a
loose one that keeps accusing real purchases, because two coffees at the same shop on the
same day for the same price are genuinely two coffees.

The check runs at the end of the job against the user's own receipts. A match sets
`duplicate_of_receipt_id` and `status = 'needs_review'`. Nothing is deleted, ever.

The byte-identical case never reaches here: `upload()` already resolves a re-uploaded
identical file to the existing document. Because `(user_id, document_id)` is unique, a
receipt built on a document that already has one is refused with 409 and the existing
receipt's id, and the sheet says "You already saved this receipt" with a link to it.

The user resolves it on the Budget list, where the receipt carries a **Possible duplicate**
badge. Tapping it shows the two side by side with their items and offers **Keep both**,
which clears the flag, or **Delete this one**, which deletes the receipt and trashes its
documents.

### 7. Categorising items

**In the same call.** The prompt lists every automatic item category by name and
description, the model returns a category name per line, and the model layer resolves each
name against the vocabulary, dropping the category but keeping the line when the name is
not one of them. Below 0.5 confidence a line is left uncategorised rather than guessed at.
No second call and no per-item call: a sixty line receipt would be sixty calls, which is
absurd for a feature about spending less.

**The cost shape is the same as sorting and is stated the same way.** Every automatic
category's description goes into the prompt of every receipt, so a verbose vocabulary costs
more per receipt. The Item categories page shows the count of automatic categories for
exactly the reason the Sorting page does.

**A correction is a correction, not training.** Changing a line's category sets
`category_source = 'manual'`, and a re-read never overwrites a manual value. The rules
module's example and correction machinery is document-scoped and is deliberately not
reused: wiring it to line items would be a large change to working code for a benefit
nobody has asked for.

**Presets**, seeded lazily per user behind an internal `budget.itemCategoriesSeeded` flag,
skipping any name the user already owns: Groceries, Meat and fish, Fruit and vegetables,
Dairy, Bakery, Drinks, Alcohol, Snacks, Household, Personal care, Baby, Pet, Pharmacy,
Clothing, Electronics, Home and garden, Fuel, Transport, Restaurant and takeaway, Deposit
and refund, Other. Deposit and refund earns its place: bottle deposits are the commonest
reason items do not sum to the total.

### 8. What the Budget section shows

One page, `/budget`, answering one question: **where did the money go this month.**

- A month switcher, defaulting to this month.
- The month total, listed per currency because nothing is converted.
- Spend by item category, as a list with an amount and a proportion bar, biggest first,
  Unmatched last. Tapping one filters the receipts below. No chart library.
- The month's receipts, newest first: merchant, date, total, and a badge when something
  needs review. Cards on a phone, a table on a desktop, via `useIsMobile()`.
- Tapping a receipt opens its detail: header values, lines with their categories, printed
  total against items total when they disagree, and a link to the document in the library.

No trends, no budget-versus-actual, no forecasting. The month list carries its items, so
the breakdown is summed on the client and there is no aggregation endpoint.

**The second budget, when it comes:** one column, `budget_id text not null default
'family'`, on `budget_receipts`, a small `budgets` table of id and name, a picker in the
capture sheet, and a filter on this page. Existing rows take the default and nothing
migrates. That is the whole change, which is why it is safe not to build it now.

### 9. Module layout and testing

`apps/server/src/modules/budget/`: `budget.tables.ts`, `budget.types.ts`, `budget.schemas.ts`
(strict HTTP input, loose LLM reply), `budget.models.ts` (the prompt, normalising a reply
row, the duplicate rule, the reconciliation check, all pure), `budget.repository.ts`,
`budget.usecases.ts` (the job handler and CRUD orchestration), `budget.routes.ts`. Client:
`pages/budget/BudgetPage.tsx`, `pages/budget/ItemCategoriesPage.tsx`,
`components/budget/CaptureSheet.tsx`, `lib/budget-api.ts`.

- Unit, on models: a reply with a bad row keeps the good rows, an unknown category name is
  dropped and the line kept, items that do not sum flag review, a 0.01 rounding difference
  does not, the duplicate rule with four matching values and with each one differing, text
  over the cap is truncated.
- Integration, in-memory SQLite, fake AI adapter: three photos become one receipt with
  items, the job waits while a page is still extracting, a failed page is skipped and named,
  a duplicate is flagged and not deleted, a manual category survives a re-read, a second
  receipt on the same document is refused with 409.
- Client: the capture sheet groups several shots into one save, and the month list renders
  as cards below the md breakpoint.

## Out of scope

- Budgets as limits: a monthly cap, alerts, "you have spent 80 percent of groceries". The
  user asked to record spending, not to be policed by it.
- Bank or card statement import, and any reconciliation against one.
- Multiple budgets, covered above as a later additive change.
- Currency conversion, exchange rates, any cross-currency total.
- Trends across months, forecasting, and export beyond what the export module already does.
- Splitting a receipt between people, and anything else implying more than one user.

## Risks

- **Cost per receipt is the real one.** Every photo is an ordinary document, so a four page
  receipt runs four extractions, four summaries, four embeddings and four sorting passes,
  plus the one receipt call. That is a lot of paid calls for a feature about spending less.
  This ships as it is and the first real multi page receipt gets watched on the jobs page.
  If the cost is what it looks like, the lever is one condition in extraction: a document
  with a parent that belongs to a receipt skips summarize and rules. Measured first, not
  guessed at up front.
- **OCR on a crumpled thermal receipt is the weak link.** Faded ink and a curled edge beat
  Tesseract, and the vision fallback only triggers below the confidence threshold. Editing
  by hand is the answer, which is why every field is editable and Re-read exists. If OCR
  loses most of the time in real use, the honest change is to send receipt photos straight
  to vision and skip OCR, with evidence behind it.
- **The vocabulary grows quietly.** Twenty one presets in every receipt prompt is fine.
  Fifty hand-written ones of three sentences each is a different bill, and it arrives
  without anyone noticing. Hence the count on the page.
- **A receipt is a purchase list**, more detailed about a person than anything else in the
  library. Same auth, same storage, nothing new exposed, but worth saying before it is built.
