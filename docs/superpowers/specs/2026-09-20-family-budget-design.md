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
- **One category vocabulary, used in two places.** The user asked for the receipt itself
  to carry a category too, alongside its line items: "maybe the budget_receipt shoud also
  have categories like groceries, household, appliences." Since the user's own examples
  for a receipt overlap with the item examples, this is one list read by both, not a
  second vocabulary to maintain. See section 2 for the shared table and section 7 for how
  each of the two places is set.
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
| `ai` module's loose reply schema discipline | the reply-schema style from `summary.schemas.ts`; the receipt read itself needs a new `AiAdapter` method, see section 4 |
| `use-media-query.ts` | `useIsMobile()` already decides table versus card list; the capture sheet is the phone branch |

### 2. Three new tables

Every column the user is being asked to approve is here, in one place.

**`budget_categories`**, the shared vocabulary, read by a receipt as a whole and by its
line items alike. Deliberately the four attributes the user named and no more. No
confidence threshold column: `document_types` has one because the sorter compares per
target, and here one global floor does the job.

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

**`budget_receipts`**, one row per receipt.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text pk | |
| `user_id` | text not null | |
| `document_id` | text not null | references `documents(id)` on delete cascade. Page 1 |
| `merchant` | text | as printed, editable |
| `category_id` | text | references `budget_categories(id)` on delete set null. The receipt's own category, read from the same vocabulary as its items, see section 7 for why this is never derived from them |
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
| `category_id` | text | references `budget_categories(id)` on delete set null, the same table the receipt's own category points at |
| `category_source` | text | `auto` or `manual`, the two values `documents.category_source` already uses |
| `confidence` | real | the model's confidence in the category. Nothing reads this yet; it is there for a later low-confidence indicator on the line, not built now |
| `created_at`, `updated_at` | text not null | |

Index: `(receipt_id, line_number)`.

**Why one table and not two.** A grocery run that also picks up a kettle is a groceries
receipt with one appliance item on it: the receipt's category and its items' categories
answer different questions and are free to disagree, but they draw on the same names
because the user's own examples for each overlap. The receipt's `category_id` is set by
the model reading the receipt as a whole and is correctable like every other field, never
computed from the items it contains, the same way `total` is never adjusted to match the
items' sum, see section 4.

**Nothing else changes in the schema.** No receipt pages table: `parent_document_id`
already links them and their capture order is their `created_at` order, derived not stored.
No items total column: it is the sum of the item rows, computed when read. No month column:
`purchased_at` is indexed and a month is a string prefix.

**One additive, non-schema change.** `POST /api/documents` gains an optional
`parentDocumentId` query parameter, so the capture sheet can file page 2 under page 1
through the upload path that already exists instead of getting its own upload endpoint.

### 3. The capture flow

This is the interaction that matters. Someone is standing at a till.

1. The Budget page has one primary button, **Scan receipt**, in thumb reach on a phone. It
   is a file input with `accept="image/*"` and `capture="environment"`, which opens the
   camera directly on iOS and Android and stays an ordinary file picker on a desktop.
2. Each shot lands in a staging list in the sheet with a thumbnail and a page number.
   **Add another page** takes the next shot. Everything in the staging list is one receipt:
   that is the explicit grouping. A shot can be removed before saving. The button disables
   at ten photos, see section 4 for why ten.
3. **Save** uploads page 1, then each remaining page with `?parentDocumentId=<page 1>`, then
   posts `{ documentIds }` to `/api/budget/receipts`. The receipt row is created `pending`
   and a `receipt` job is enqueued.
4. The sheet closes at once and the receipt appears at the top of the month list with a
   spinner and "Reading receipt". Nobody waits in a shop, and closing the app is safe
   because the work is a job on the server.
5. It lands as `ready` or `needs_review`, with a badge saying which.

**When extraction gets it wrong**, which it will: every value is editable. Merchant, date,
total, tax and currency on the receipt, description, quantity, amount and category on each
line, plus add a line and delete a line. One **Re-read** button re-runs the job over the
same photos for when the first pass was garbage and fixing it by hand is more work than
trying again. It discards the extracted lines, so it asks first.

### 4. Reading the line items

**One vision call per receipt, over every photo together.** Decided after this spec was
first written: send every shot from one receipt to the model in a single request, not OCR
text read page by page. The receipt job passes page 1's image and every child page's image
to one call, in capture order, and gets back the header values, a category for the receipt
as a whole, the items, and a category per item, all in the same reply, see section 7.

**A new `AiAdapter` method, not a bigger `generateStructured`.** No existing method takes
several images and returns validated JSON: `generateStructured` takes a string and no
images, `recognizeImage` takes one image and returns freeform text. The new method is
implemented in both `openai-compatible.adapter.ts` and `anthropic.adapter.ts`, largely by
combining the image content block assembly each already has inside `recognizeImage` with the
JSON schema assembly each already has inside `generateStructured`. A new method rather than
a wider `generateStructured` keeps the summary and rules call sites untouched. It resolves
through the **vision** slot, gated on `capabilities.vision` **and** `capabilities.structured`
together, since a model that reads images is not guaranteed to also support JSON schema
mode. Which vision-slot models are known to support both is worth a settings page note
later, not something to build now. Also worth fixing while this ships: `DOCMIND-DESIGN.md`'s
"Model slots" paragraph still says "Rules, chat, embedding," but `ModelSlot` in
`ai.types.ts` has had a fourth, `vision`, for a while; naming all four there is overdue.

**The evidence behind this.** A live spike sent two real receipt photos as two `image_url`
parts in one call to `google/gemini-2.5-flash` through OpenRouter: HTTP 200, 584 prompt
tokens, $0.0003 total. Asked to read them as pages of one receipt, the model did not merge
two unrelated receipts into a wrong total; it answered `{"merchant": null, ..., "items": [],
"warning": "Clearly two different receipts"}`.

**A flat limit of ten photos per receipt.** It guards a degenerate upload, someone stapling
in fifty shots or a bug in the capture sheet, not cost: at the spike's price a normal one to
four photo receipt costs a fraction of a cent regardless of the limit. The capture sheet
disables **Add another page** at ten; the server re-validates the same limit on
`POST /api/budget/receipts` and answers 400 over it, for any client that skips the sheet.

**One prompt line about overlap.** Shots of a long receipt often overlap by a line or two,
so the prompt tells the model not to count a line twice when it appears on two photos. The
existing reconciliation tolerance below catches a double count anyway, because it pushes the
item sum past the printed total.

**What the server does with the answer.** A `warning` field alone is not enough. A
non-empty `warning` forces `status = 'needs_review'` and copies its text into the receipt's
`note`, rather than trusting a ready status. An answer whose header fields (`merchant`,
`purchased_at`, `total`, `currency`) are all null is a failed read, `status = 'failed'` with
a note, not a receipt with a blank total: a null `total` would otherwise drop silently out of
the month total instead of failing visibly.

**Items that do not sum to the total** is the normal case, not the error case: discounts,
loyalty points, bottle deposits and rounding all break the sum. Neither number is ever
adjusted to fit the other. `total` is what was printed, the items are what was printed, and
their sum is derived when read. When the two differ by more than 0.02 the receipt is
`needs_review` with the difference in the note, and the detail screen shows both numbers
with the gap named. The month total counts `total`, because that is the money that left the
account. The category breakdown counts items and shows the remainder as its own row called
Unmatched rather than hiding it.

**Valibot at the boundary, loose.** `items` is `v.unknown()`, every header value is an
optional loose string, and `warning` is an optional string too. The new method parses a
whole reply in one pass and throws on any nested failure the same way `generateStructured`
does, so asserting the shape of the items array would throw away a correct merchant and
total because one line came back malformed. Every check happens after parsing, in
`budget.models.ts`, dropping only the offending row. HTTP input schemas stay strict.

### 5. When the job runs

The receipt job needs only the uploaded bytes, and those exist the moment every page
finishes uploading, before extraction has done anything with them. So the job reads each
page straight from storage the way `extraction.usecases.ts` already does, and runs at once:
no polling, no waiting. This is what the user's one-call decision buys for free. It removes
the self-requeuing job that would otherwise poll whether every page's OCR had finished, its
tries counter, its ten minute cap, and the `availableAt` argument `jobs.enqueue` would have
needed for it: none of that exists now because there is nothing left to wait for.

### 6. Duplicates

Two receipts are the same when all four of these match: merchant compared
case-insensitively and trimmed, `purchased_at`, `total`, and `currency`. Nothing fuzzy, no
tolerance on the total, no time window. A confident rule that occasionally misses beats a
loose one that keeps accusing real purchases, because two coffees at the same shop on the
same day for the same price are genuinely two coffees.

The exact match on merchant also means a rescan of the same receipt can slip past this if
the model reads the merchant string slightly differently between the two reads. That is the
accepted side of the same tradeoff: missing an occasional real duplicate beats flagging real
purchases as duplicates.

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

### 7. Categorising the receipt and its items

**In the same call, for both the receipt and every line.** The prompt lists every
automatic category by name and description, once, and the model returns a category name
for the receipt as a whole alongside a category name per line. The model layer resolves
each returned name against the vocabulary independently for the receipt and for every
item, dropping the category but keeping the receipt or the line when the name is not one
of them. Below 0.5 confidence a receipt or a line is left uncategorised rather than
guessed at. No second call and no per-item call: a sixty line receipt would be sixty
calls, which is absurd for a feature about spending less.

**The receipt's category is never derived from its items.** A grocery run with one
kettle in the basket is a groceries receipt carrying one appliance item: deriving the
receipt's category from a vote or a sum over the items would get exactly that case wrong.
Both categories come out of the same read of the same photos and are independently
correctable afterwards.

**The cost shape is the same as sorting and is stated the same way.** Every automatic
category's description goes into the prompt of every receipt, so a verbose vocabulary
costs more per receipt. The Categories page shows the count of automatic categories for
exactly the reason the Sorting page does.

**A correction is a correction, not training.** Changing the receipt's category or a
line's category sets `category_source = 'manual'` on that row, and a re-read never
overwrites a manual value. The rules module's example and correction machinery is
document-scoped and is deliberately not reused: wiring it to a receipt or its line items
would be a large change to working code for a benefit nobody has asked for.

**Presets**, seeded lazily per user behind an internal `budget.categoriesSeeded` flag,
skipping any name the user already owns, covering both a whole receipt and a single line
since one vocabulary now serves both: Groceries, Household, Meat and fish, Produce,
Bakery, Drinks, Pharmacy and health, Personal care, Baby, Pet, Appliances, Electronics,
Clothing, Home and garden, Fuel, Transport, Restaurant and takeaway, Entertainment,
Services, Other.

The seed check runs on the same precedent as `ensureTypesSeeded`, called lazily inside
`rules.usecases.ts` right before the sort prompt is built, never at server start since a
fresh install has no user at boot. Here the equivalent call site is inside the receipt job
handler, immediately before the categorisation prompt is built.

### 8. What the Budget section shows

One page, `/budget`, answering one question: **where did the money go this month.**

- A month switcher, defaulting to this month.
- The month total, listed per currency because nothing is converted.
- Spend by category, as a list with an amount and a proportion bar, biggest first,
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
`pages/budget/BudgetPage.tsx`, `pages/budget/CategoriesPage.tsx`,
`components/budget/CaptureSheet.tsx`, `lib/budget-api.ts`.

- Unit, on models: a reply with a bad row keeps the good rows, an unknown category name is
  dropped and the line kept, items that do not sum flag review, a 0.01 rounding difference
  does not, the duplicate rule with four matching values and with each one differing, a
  non-empty warning forces `needs_review` and lands in the note, a reply whose header fields
  are all null is a failed read.
- Integration, in-memory SQLite, fake AI adapter: two photos become one receipt with items
  from a single call, a duplicate is flagged and not deleted, a manual category survives a
  re-read, a second receipt on the same document is refused with 409, an eleventh photo is
  refused with 400, receipt creation cancels a still-pending rules job on a child page.
- Client: the capture sheet groups several shots into one save and disables **Add another
  page** at ten, and the month list renders as cards below the md breakpoint.

## Out of scope

- Budgets as limits: a monthly cap, alerts, "you have spent 80 percent of groceries". The
  user asked to record spending, not to be policed by it.
- Bank or card statement import, and any reconciliation against one.
- Multiple budgets, covered above as a later additive change.
- Currency conversion, exchange rates, any cross-currency total.
- Trends across months, forecasting, and export beyond what the export module already does.
- Splitting a receipt between people, and anything else implying more than one user.

## Risks

- **Cost per receipt, and why child pages do not each pay full price.** Every photo is an
  ordinary document, so left alone a four page receipt would run four extractions, four
  summaries, four embeddings and four sorting passes, plus the one receipt call. Local OCR
  still runs on every page, since it costs nothing, but only page 1 needs the paid
  follow-on pipeline: summarize, rules and embedding exist to make a document findable in
  search and chat, and the receipt record is what represents the purchase from here on, not
  the child pages. Pages upload, and their extraction jobs can already run, before the
  receipt row exists for a lookup to find, so extraction cannot gate itself on "does this
  belong to a receipt." Instead the budget module's own receipt creation step cancels any
  still-pending rules, summarize and embedding jobs for the child pages and marks those
  statuses done. This is best effort, contained in the new module rather than a change to
  the shared upload or extraction path: it can occasionally miss a job the runner already
  claimed in the few seconds between upload and the receipt POST, in which case that page
  gets the full ordinary pipeline anyway, a miss on cost, not on correctness.
- **OCR on a crumpled thermal receipt is the weak link, but only for search.** The receipt
  reading itself already goes straight to vision on the photos, so this is about
  extraction's separate OCR pass, the one that makes a page findable in search and chat:
  faded ink and a curled edge beat Tesseract there. It has no bearing on how well the
  receipt call reads the same photo. A genuinely bad photo still beats any model, which is
  why every field is editable and Re-read exists.
- **The vocabulary grows quietly.** Twenty presets in every receipt prompt is fine.
  Fifty hand-written ones of three sentences each is a different bill, and it arrives
  without anyone noticing. Hence the count on the page.
- **A receipt is a purchase list**, more detailed about a person than anything else in the
  library. Same auth, same storage, nothing new exposed, but worth saying before it is built.
