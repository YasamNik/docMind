# D4: Inbox Triage, design spec

Status: draft, 2026-09-17. Parent spec: `2026-09-17-phase-2-find-and-ask-design.md`,
section 11.4. Feature: `docs/FEATURES.md` item #23.

## 1. Problem statement

New documents enter DocMind, get extracted, summarized, and sorted by rules, but there is
no review step where the user sees what the AI did and confirms it. The initial rules
evaluation auto-applies tags and categories silently. The user discovers the AI's
decisions only by browsing individual document detail pages.

The goal: every new document lands in an Inbox that shows the AI's proposed title,
summary, applied tags, applied category, and the reasoning behind each decision. One tap
accepts everything. Inline editing lets the user correct anything before filing. Rules
results are visible before the user considers them settled.

## 2. Current flow vs proposed flow

### 2.1 Current flow

1. Upload creates a document row with `ruleStatus = 'pending'`.
2. Extraction job runs; on completion enqueues rules, embedding, and summarize jobs.
3. Initial rules job auto-applies tags and categories (outcome: `applied`). Sets
   `ruleStatus = 'done'`.
4. Summarize job sets `summary`, `suggestedTitle`, `summaryStatus = 'done'`.
5. The document appears in the All Documents table. The user must open the detail page
   to see what was applied.

The current `inbox` view (`ruleStatus IN ('pending', 'processing')`) shows documents
whose rules are still running. Once rules finish, the document leaves the inbox without
the user ever reviewing it.

The `needs_review` view (`ruleStatus = 'done' AND (no category OR has proposals)`) only
catches documents that have no category or have unresolved proposals from rerun mode. A
document that was fully sorted by initial mode (category set, tags applied) never appears
in either view.

### 2.2 Proposed flow

1. Upload creates a document row with `triageStatus = 'pending'` (new column).
2. Extraction, rules, embedding, and summarize jobs run as before. Initial mode still
   auto-applies tags and categories.
3. The document appears in the Inbox because `triageStatus = 'pending'`.
4. The inbox card shows: pipeline progress, summary, suggested title, applied tags and
   category (each with the AI's reasoning from `sort_evaluations`), and any proposals.
5. The user taps "Accept" to mark the document as reviewed (`triageStatus = 'reviewed'`).
   Or the user edits tags, category, or title inline and then accepts.
6. The document leaves the Inbox and appears only in All Documents.

Key difference: every new document stays visible in the Inbox until the user explicitly
reviews it, regardless of whether the AI successfully sorted it.

## 3. Decisions

**Decision 1: Add a `triageStatus` column rather than reusing existing status columns.**
The existing `ruleStatus`, `summaryStatus`, and `embeddingStatus` columns track pipeline
progress. None of them represent "the user has reviewed this document." A dedicated
`triageStatus` column cleanly separates pipeline state from review state. Values:
`pending` (in inbox) and `reviewed` (filed). This is the smallest possible schema change,
one column with a default.

**Decision 2: Redefine the `inbox` view to use `triageStatus`.**
The current inbox definition (`ruleStatus IN ('pending', 'processing')`) is a poor proxy
for "needs user attention." The new definition is simply `triageStatus = 'pending'`. This
means the inbox shows documents still being processed AND documents whose processing
finished but the user has not reviewed. The client distinguishes these states visually
using the existing pipeline status columns.

**Decision 3: Keep the `needs_review` view as-is.**
The `needs_review` view serves a different purpose: it highlights documents with unresolved
proposals from rerun evaluations or documents without a category. It remains useful as a
secondary filter for the sorting workflow. It operates independently of `triageStatus`.

**Decision 4: Do not change how initial mode applies results.**
The Phase 2 spec (decision 12) designed inbox triage as a view enhancement, not a change
to the rules engine. Initial mode keeps auto-applying tags and categories. The inbox shows
what was applied (with reasoning) so the user can override. This avoids adding a "pending
review" step to the pipeline that would delay sorting until the user acts.

**Decision 5: Expose evaluation results for all outcomes, not just proposals.**
Currently, only `proposed` evaluations are exposed through the API. For the inbox to show
reasoning behind auto-applied tags and categories, we need a new endpoint that returns the
latest evaluations for a document regardless of outcome. This is also useful on the
document detail page.

**Decision 6: Inbox is the default landing view.**
After sign-in, the app navigates to the Inbox. If the inbox is empty, it falls back to the
All Documents view with a brief "All caught up" message. This makes triage the primary
workflow.

**Decision 7: Re-processing does not reset triageStatus.**
Re-extracting or re-running rules on a reviewed document does not send it back to the
inbox. The user has already seen it. If new proposals emerge from a rerun, they appear in
the `needs_review` view, which is the correct place for post-review changes. This avoids
inbox pollution from routine re-evaluations.

**Decision 8: "Accept" is always explicit.**
Editing a document's tags, category, or title does not auto-mark it as reviewed. The user
must tap "Accept" or "Accept and file" to move the document out of the inbox. This lets the
user make partial edits and come back later.

**Decision 9: Inbox renders as cards, not table rows.**
The inbox is a triage view, not a browsing view. Cards show more context at a glance:
summary text, tag/category chips, reasoning snippets, pipeline progress. The All Documents
table remains for browsing and filtering.

**Decision 10: Batch accept for efficiency.**
The inbox offers "Accept all ready" to mark all fully-processed documents as reviewed in
one action. A document is "ready" when extraction, rules, and summary are all done (or
done/failed with no pending retry).

## 4. Schema changes (NEEDS USER APPROVAL)

### 4.1 New column on `documents`

```
triageStatus TEXT NOT NULL DEFAULT 'pending'
```

Values: `'pending'` (in inbox) or `'reviewed'` (filed by user).

### 4.2 Migration

Migration name: `add_triage_status`.

1. Add the `triageStatus` column with `DEFAULT 'pending'`.
2. Immediately update all existing rows to `'reviewed'` so they do not flood the inbox.
   SQLite applies the default to new rows going forward; existing documents that were
   processed before inbox triage existed are considered already reviewed.

```sql
ALTER TABLE documents ADD COLUMN triage_status TEXT NOT NULL DEFAULT 'pending';
UPDATE documents SET triage_status = 'reviewed';
```

This is additive (new column with a default), non-destructive, and backward-compatible.

### 4.3 Index

Add a composite index for efficient inbox queries:

```
documents_user_triage_idx ON (user_id, triage_status)
```

The inbox query filters on both columns frequently.

## 5. Server changes

### 5.1 documents.tables.ts

Add `triageStatus` column:

```ts
triageStatus: text("triage_status").notNull().default("pending"),
```

Add the new index to the table's index array.

### 5.2 documents.types.ts

`DocumentView` gains no new values; `inbox` already exists and its definition changes.
Types update automatically through Drizzle inference (`Document`, `NewDocument`).

Add `DocumentTriageStatus = 'pending' | 'reviewed'` type alias for clarity.

### 5.3 documents.repository.ts

Change `buildViewConditions` for the `inbox` view:

Before: `inArray(documentsTable.ruleStatus, ["pending", "processing"])`
After: `eq(documentsTable.triageStatus, "pending")`

Add `updateTriageStatus` method for single document and batch:

```ts
async updateTriageStatus({ userId, documentId, status }: { ... })
async updateTriageStatusBatch({ userId, documentIds, status }: { ... })
```

### 5.4 documents.usecases.ts

Add `acceptTriage` method:

```ts
async acceptTriage({ userId, documentId }: { ... })
```

Sets `triageStatus = 'reviewed'` and `updatedAt`. Optionally accepts the suggested title
if one exists and the user's request includes `acceptTitle: true`.

Add `acceptTriageBatch` method:

```ts
async acceptTriageBatch({ userId, documentIds }: { ... })
```

Bulk update for "Accept all ready." Validates all documents belong to the user and have
`triageStatus = 'pending'`.

### 5.5 documents.routes.ts

Two new routes:

```
POST /api/documents/:id/triage
  body: { action: 'accept', acceptTitle?: boolean }
  -> { document }

POST /api/documents/triage
  body: { documentIds: string[], action: 'accept' }
  -> { updatedCount: number }
```

### 5.6 documents.schemas.ts

New schemas:

```ts
const triageActionSchema = v.object({
  action: v.literal('accept'),
  acceptTitle: v.optional(v.boolean(), false),
});

const triageBatchSchema = v.object({
  documentIds: v.pipe(v.array(documentIdSchema), v.minLength(1), v.maxLength(100)),
  action: v.literal('accept'),
});
```

### 5.7 rules.routes.ts (enhancement)

New route for full evaluation history:

```
GET /api/documents/:id/evaluations
  -> { evaluations: EvaluationRow[] }
```

Returns the latest evaluation for each (targetType, targetId) pair for the document, with
all outcomes (applied, below_threshold, no_match, proposed, dismissed). Includes the
target name resolved from tags/categories tables.

### 5.8 rules.repository.ts (enhancement)

New method:

```ts
async listLatestEvaluationsForDocument({ userId, documentId }: { ... })
```

Fetches the most recent evaluation per target for a document, joining with document to
verify ownership. Returns rows with: targetType, targetId, matched, confidence, reasoning,
outcome, proposalKind, evaluatedAt. This uses a subquery or window function to pick the
latest evaluation per target.

### 5.9 rules.usecases.ts (enhancement)

New method:

```ts
async listEvaluationsForDocument({ userId, documentId }: { ... })
```

Calls the repository, enriches with tag/category names (same pattern as
`enrichProposals`), and returns typed evaluation results.

### 5.10 counts endpoint update

The existing `GET /api/documents/counts` returns `{ inbox, needsReview }`. The `inbox`
count now reflects `triageStatus = 'pending'` via the updated `buildViewConditions`.

## 6. Client changes

### 6.1 New page: InboxPage.tsx

Route: `/inbox`. A dedicated page for triage, not a filter on DocumentsPage.

Layout: a vertical stack of cards, newest first. Each card contains:

- **Header row:** Document name (or suggested title if available, with original name shown
  smaller). Pipeline status badges (extraction, rules, summary).
- **Body:** Summary text (if available). If summary is still processing, show a
  "Summarizing..." placeholder.
- **Tags section:** Applied tags as chips, each with an "(auto)" badge and a tooltip or
  expandable showing the AI's reasoning. Manual tags shown without reasoning.
- **Category section:** Applied category path with "(auto-filed)" label and reasoning.
  If no category, show "No category."
- **Proposals section:** If there are pending proposals (from reruns), show them with
  accept/dismiss checkboxes (reuse the existing ProposalsReview pattern).
- **Actions:**
  - "Accept" button (primary): marks `triageStatus = 'reviewed'`. If there is a
    suggested title, a sub-option "Accept with title" applies it.
  - "View" link: navigates to the document detail page for full editing.
  - "Edit" toggle: expands inline editing for tags and category (reuse CategoryPicker
    and TagPicker from DocumentDetailPage).

Empty state: "All caught up. No new documents to review." with a link to All Documents.

Auto-refresh: poll every 5 seconds while any document has a pipeline still running.
Stop polling when all documents are fully processed or the inbox is empty.

### 6.2 InboxCard component

Extract the inbox card into `apps/client/src/components/documents/InboxCard.tsx` so it can
be reused on the document detail page if needed.

Props: document data, evaluations, proposals, callbacks for accept/edit actions.

### 6.3 App.tsx routing changes

- Add `/inbox` route pointing to `InboxPage`.
- Change the default redirect: `<Route index element={<Navigate to="/inbox" replace />} />`

### 6.4 AppShell.tsx navigation changes

- "Inbox" nav link points to `/inbox` instead of `/documents?view=inbox`.
- "All documents" link stays at `/documents`.
- Remove the `view=inbox` query param approach from the Files panel.
- Keep the inbox count badge on the nav link.

### 6.5 DocumentDetailPage.tsx enhancements

- Show an "Accept and file" button when `triageStatus === 'pending'`. Clicking it calls
  the triage endpoint and shows a success toast.
- Show evaluation reasoning for applied tags and categories (using the new evaluations
  endpoint). This gives the detail page full transparency about AI decisions, not just
  proposals.

### 6.6 documents-api.ts additions

```ts
acceptTriage(id: string, acceptTitle?: boolean): Promise<DocumentDetail>
acceptTriageBatch(documentIds: string[]): Promise<{ updatedCount: number }>
listEvaluations(id: string): Promise<EvaluationRow[]>
```

### 6.7 DocumentsPage.tsx cleanup

Remove the `inbox` view handling from DocumentsPage since inbox is now a separate route.
The `view` parameter keeps `needs_review` and `all` values.

## 7. Migration path for existing documents

1. The migration adds `triage_status` with `DEFAULT 'pending'` and immediately sets all
   existing rows to `'reviewed'`.
2. Documents uploaded after the migration land with `triage_status = 'pending'`
   automatically (column default).
3. The inbox view immediately works: it shows only new documents uploaded after the
   migration.
4. No data is lost. No existing behavior changes except the inbox view definition.

## 8. Test strategy

### 8.1 Unit tests

- `documents.models.ts` (if logic is added): triage status transitions.
- No significant pure logic for triage; most logic is in usecases.

### 8.2 Integration tests (server)

- **acceptTriage**: upload a document, verify `triageStatus = 'pending'`, call the triage
  endpoint, verify `triageStatus = 'reviewed'`.
- **acceptTriage with title**: upload, run summarize (mocked), verify suggested title
  exists, accept triage with `acceptTitle: true`, verify name changed and
  `triageStatus = 'reviewed'`.
- **acceptTriageBatch**: upload 3 documents, batch accept, verify all are reviewed.
- **inbox view filter**: upload 2 documents, accept one, list with `view=inbox`, verify
  only the unaccepted document appears.
- **counts**: upload a document, verify inbox count is 1, accept it, verify inbox count
  is 0.
- **evaluations endpoint**: run initial rules (mocked), query evaluations, verify applied
  outcomes with reasoning are returned.
- **re-processing does not reset triage**: accept a document, re-extract it, verify
  `triageStatus` stays `'reviewed'`.

### 8.3 Integration tests (client)

- InboxPage renders cards for pending documents.
- Accept button calls the triage API and removes the card.
- Batch accept calls the batch API.
- Empty state shows when inbox is empty.
- Pipeline status badges update as jobs complete.

### 8.4 Manual acceptance test

1. Upload a PDF. Verify it appears in the Inbox with a processing indicator.
2. Wait for extraction, rules, and summary to complete. Verify the card shows: summary,
   suggested title, applied tags with reasoning, applied category with reasoning.
3. Click "Accept." Verify the document leaves the inbox and appears in All Documents.
4. Upload another document. On the inbox card, click "View" to go to the detail page.
   Edit the category. Go back to the inbox. Verify the document is still there (not
   auto-accepted).
5. Click "Accept." Verify it leaves the inbox.
6. Upload 3 documents. Wait for processing. Click "Accept all ready." Verify all three
   leave the inbox.

## 9. Risks

1. **Schema change requires migration.** Adding `triageStatus` touches `documents.tables.ts`
   and requires a `db:generate` step. The schema-changes rule mandates doing both in the
   same task. Risk is procedural, not technical.

2. **Inbox count query performance.** The inbox count query adds a WHERE clause on
   `triage_status = 'pending'`. With the composite index
   `(user_id, triage_status)`, this is a covered index scan. For a single-user app with
   thousands of documents, this is fast. No performance concern.

3. **Evaluations endpoint query complexity.** Fetching the latest evaluation per target
   for a document requires either a correlated subquery or a window function. SQLite
   supports both. The expected row count per document is small (number of automatic
   tags + categories, typically under 50). No performance concern.

4. **Client data fetching.** The inbox page needs: document list, evaluations per
   document, proposals per document. Fetching evaluations and proposals individually per
   document would be N+1. Mitigation: add a bulk evaluations endpoint
   (`GET /api/evaluations?documentIds=id1,id2,...`) or include evaluations in the inbox
   list response. The plan should choose one approach. The simpler option is to fetch
   evaluations per card on mount (they are small payloads) and accept the N+1 for V1,
   since the inbox typically has fewer than 20 documents.

5. **View definition change is a semantic break.** The `inbox` view changes from "rules
   still running" to "user hasn't reviewed." Any code or client logic depending on the old
   meaning must be updated. Currently only `documents.repository.ts` and `AppShell.tsx`
   use the inbox view. The DocumentsPage still supports `view=inbox` through query params;
   since the inbox is now a separate route, this should be cleaned up.

## 10. Files touched

### Server (new)
- `apps/server/drizzle/XXXX_add_triage_status.sql` (migration)

### Server (modified)
- `apps/server/src/modules/documents/documents.tables.ts` (new column, new index)
- `apps/server/src/modules/documents/documents.types.ts` (new type alias)
- `apps/server/src/modules/documents/documents.repository.ts` (inbox view, triage methods)
- `apps/server/src/modules/documents/documents.usecases.ts` (triage usecases)
- `apps/server/src/modules/documents/documents.routes.ts` (triage routes)
- `apps/server/src/modules/documents/documents.schemas.ts` (triage schemas)
- `apps/server/src/modules/rules/rules.repository.ts` (evaluations query)
- `apps/server/src/modules/rules/rules.usecases.ts` (evaluations usecase)
- `apps/server/src/modules/rules/rules.routes.ts` (evaluations route)

### Client (new)
- `apps/client/src/pages/inbox/InboxPage.tsx`
- `apps/client/src/pages/inbox/InboxPage.test.tsx`
- `apps/client/src/components/documents/InboxCard.tsx`

### Client (modified)
- `apps/client/src/App.tsx` (new route, default redirect)
- `apps/client/src/components/layout/AppShell.tsx` (nav link update)
- `apps/client/src/lib/documents-api.ts` (triage API functions)
- `apps/client/src/pages/documents/DocumentsPage.tsx` (remove inbox view handling)
- `apps/client/src/pages/documents/DocumentDetailPage.tsx` (accept-and-file button,
  evaluation reasoning display)

### Tests (new)
- `apps/server/src/modules/documents/documents.triage.test.ts`
- `apps/server/src/modules/rules/rules.evaluations.test.ts`
- `apps/client/src/pages/inbox/InboxPage.test.tsx`

## 11. Task breakdown

### Task 1: Schema and migration
- Add `triageStatus` column to `documents.tables.ts`
- Generate migration with `db:generate --name add_triage_status`
- Edit migration to add `UPDATE documents SET triage_status = 'reviewed'`
- Update `documents.types.ts`
- Commit: `feat(server): add triageStatus column to documents table`

### Task 2: Server triage logic
- Update `buildViewConditions` inbox filter in `documents.repository.ts`
- Add `updateTriageStatus` and `updateTriageStatusBatch` repository methods
- Add `acceptTriage` and `acceptTriageBatch` usecases in `documents.usecases.ts`
- Add triage schemas in `documents.schemas.ts`
- Add triage routes in `documents.routes.ts`
- Write integration tests
- Commit: `feat(server): add inbox triage accept endpoints`

### Task 3: Evaluations endpoint
- Add `listLatestEvaluationsForDocument` in `rules.repository.ts`
- Add `listEvaluationsForDocument` in `rules.usecases.ts`
- Add `GET /api/documents/:id/evaluations` in `rules.routes.ts`
- Write integration tests
- Commit: `feat(server): expose evaluation history for documents`

### Task 4: Client inbox page
- Create `InboxPage.tsx` with card layout
- Create `InboxCard.tsx` component
- Add triage and evaluations functions to `documents-api.ts`
- Add `/inbox` route to `App.tsx`, update default redirect
- Update `AppShell.tsx` navigation
- Remove inbox view handling from `DocumentsPage.tsx`
- Write component tests
- Commit: `feat(client): add Inbox triage page with accept flow`

### Task 5: Detail page enhancements
- Add "Accept and file" button to `DocumentDetailPage.tsx` when `triageStatus === 'pending'`
- Show evaluation reasoning for applied tags and categories
- Commit: `feat(client): show triage accept and evaluation reasoning on detail page`

## 12. Verification

After all tasks:

1. Upload a new document. Confirm it appears in the Inbox with a processing indicator.
2. Wait for all jobs to finish. Confirm the card shows summary, title, tags, category,
   and reasoning.
3. Accept the document. Confirm it leaves the inbox and the count badge updates.
4. Confirm existing documents (uploaded before the migration) do not appear in the inbox.
5. Confirm the default landing page is the inbox.
6. Confirm batch accept works for multiple ready documents.
7. Confirm inline editing on the inbox card works for tags and category.
8. Confirm the document detail page shows "Accept and file" for inbox documents.
9. Run `pnpm test` and `pnpm typecheck` from the root. All pass.
