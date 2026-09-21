# DocMind worklog

Newest entry first. The `end-session` skill appends one entry per session. Each entry has
four parts: Done, Decisions, Comments (the user's words, not a paraphrase), Open / Next.

Active branch: `main`

## 2026-09-20 to 21: the budget section, and DocMind gets its own domain

### Done
- Assistant plan 5, the last one (245d358): the app's chat page runs on `runTurn` like
  Telegram does, with Yes and No buttons on a proposal, asked for on session select so a
  reload keeps them. Token streaming is gone, because every path out of `runTurn` is
  already buffered and streaming text before a tool call would mean retracting it.
  `answeringPromptFor` deleted once both surfaces took the same prompt.
- Family budget, specced (d32c36c, 8f562a5), reviewed, and built: three approved tables
  (6da7a64), a new AI method taking several images and returning validated JSON
  (40443d4), the read job (75b5715), and the client with a camera-first capture sheet,
  month view and categories page (471a633).
- Gmail over OAuth reached its real mailbox, and DocMind moved to `doctrank.com` and
  `app.doctrank.com` through a named Cloudflare Tunnel, now installed as a systemd
  service, active and enabled. The quick tunnel and its rotating URL are gone.
- Seven bugs fixed, four of them found by putting a real receipt through the real model
  rather than by any test: line items silently dropped because a loose schema made the
  provider return them as a JSON string (ce754de), a receipt with a total and no lines
  marked ready, the review flag about to fire on every taxed receipt because items are
  printed before tax and the total after it (2af26c6), and a re-read doubling every line
  (4f8894e).
- Three more from the user using it: the capture sheet losing the photo because Android
  reloads the page on the camera round trip, so each shot now uploads immediately and
  survives a reload (1fe3424); a receipt filed six years back and therefore invisible,
  plus receipt photos cluttering the library (ee61dfa); and signing in landing back on
  the sign in page, because better-auth schedules its session refresh rather than
  awaiting it (cd1cc9a).
- A Gmail IMAP timeout was killing the whole server: the connection emitted an error
  event nothing listened for, and node ends the process on that (f88e4aa).
- The dev watcher was serving code older than the file on disk for the third time, so it
  watches the source directory now rather than the import graph (da38445).
- Four more bug records written up (c88132a), taking the log to 21 entries.

### Decisions
- One vision call carrying every photo, decided by the user, turned out cheaper and safer
  than reading OCR text per page: about three hundredths of a cent per receipt whatever
  the page count, and the model refused to merge two photos that were not one receipt
  rather than inventing a total. It also deleted a whole waiting and requeueing mechanism
  from the spec, since the job needs only the uploaded bytes.
- One category vocabulary, not two. The user asked for a category on the receipt as well
  as on each line, and their own examples overlapped, so one list serves both. A grocery
  run with a kettle in it is a groceries receipt holding an appliance item, so the
  receipt's category is read, never derived from its lines.
- Receipt photos are not library documents. They keep their text and embedding so chat
  can still answer what was bought, but they never appear in Documents, the inbox or
  sorting, and they no longer pay for a summary or a sorting pass at all.
- Items that do not sum to the total adjust neither number. The printed total is what the
  month counts. A stated tax reconciles with or without it, since some places print tax
  inclusive prices.
- `merchant_category` was cut at review because nothing read it, and the user later asked
  for a receipt category anyway, which arrived as part of the shared vocabulary instead.
- Neither Vercel nor Cloudflare Workers can host this: DocMind is a stateful always on
  server with three background loops, a SQLite file with a native extension, and OCR
  writing to disk. A named tunnel from the user's own machine was the honest answer, and
  it also ends the URL churn that kept breaking Google OAuth.

### Comments
- "I'd like to open a new Section for Family budget , allow to take a picture by when on mobile (several images can be needed for one long receiot) all the data will be extracted filter duplication make a record with all the information from the receipts"
- "the user is one person, but budget might be different, lets say home budget and business budget. but as a simple way , start with one family budget"
- "I think for multiple shots we should send all of the shots one time to the llm at the end"
- "maybe the budget_receipt shoud also have categories like groceries , household, appliences"
- "It let me scan , but then when click ok after imeaged , nothing is happen and back to budget page"
- "i ve added coupole receipt from the phonme but i do not see them anywhere, though it seems it did ingested it at least it showed the transcript"
- "I saw it went to docs files, but should be inside the budget section"
- "If date not found on receipt, just use the scan date then"
- "often happen that after sign in i end up on the same signin page with no error but still at the same page and only on the second attempt it takes me to the app. fix that"
- "I just bought a domain name, im wondering to setup a free hosting for the docmind, where would you recommend to do that on vercel aopr cloudflair?"
- "when I ask for status show me a table view with tasks status done in  progress and next to be done"

### Open / Next
- **15 commits are unpushed.** Everything above exists only on this machine.
- DocMind itself still runs as `pnpm dev`, so a reboot brings the tunnel back to nothing
  on port 5173. Moving it to the existing `docker-compose.yml` with a restart policy is
  what makes the domain genuinely permanent, and is the obvious next infrastructure step
  once the code stops changing hourly.
- Untested on real data: a long receipt across several photos, and a creased or angled
  shot in bad light. Everything proven so far used one flat, well lit receipt.
- The budget has no assistant tool, so the chat cannot answer "what did I spend on
  groceries" from the structured tables. A capability record is the natural shape.
- `proposeInstruction` and the document scoped tool guard both remain unbuilt, recorded
  in the assistant specs.
- The SPF TXT record for `doctrank.com` did not survive the move to Cloudflare. Mail
  still arrives, but mail sent from the domain is more likely to be marked spam.

## 2026-09-19 evening: everything merged, the assistant acts, Gmail by OAuth

### Done
- Merged both outstanding branches into `main` and pushed 135 commits to `origin/main`,
  the first push since the 18th. `feat/email-intake` and `feat/assistant-triage`
  fast-forwarded; the office machine's `feat/document-types-office` (25 commits, document
  types as their own vocabulary) merged as c788b9a with its migration renumbered 0014 to
  0016 and regenerated against the merged schema.
- Seven fixes from three pre-merge reviews, then four more bugs found while fixing those:
  re-uploading a trashed file threw a 404 (`findByHash` matched trashed rows), a mail whose
  attachment already existed was filed with no attachment, the Telegram assistant went
  silent forever after its chat session was deleted (72f6f3b), and a failed Telegram send
  re-ran the whole turn including a second paid model call (86e1939).
- Diagnosed the reversed-typing report from the message still in the database:
  `ebAH i Od scOd ecnIl WhatW` reverses to exactly `WtahW lInce dOcs dO i HAbe`, so every
  character landed at position 0. The composer is uncontrolled now (098af1a), which removes
  the mechanism rather than guarding it.
- Assistant plans 2, 3 and 4 built and live-validated: the capability registry and triage
  (239359e, 6b7e6e5, df1173b), the instructions document with its 8000 character cap and
  version history (891d506, 3fa434f), and confirmation (51a5618, 6a59041, e19a1c0, e3fefcb).
  Writes now propose and wait; `/note` still writes immediately because typing it is the
  confirmation.
- Ten bug fixes recorded in `docs/bugs_fix_tracking.md` (b5fb886), plus a cross-cutting
  entry naming the pattern behind four of them.
- Gmail over OAuth, working on the user's real mailbox: spec (ed14a7d), the shared signed
  state and auth (d241a22), XOAUTH2 in the loop (f2064cc), the Email tab (57502f8), and a
  fix for the connected state still showing the app password guide (64043c7). Three real
  documents arrived, including a forwarded gas bill and its PDF attachment as a linked
  document.
- Voice notes to the Telegram bot (28817cc), transcribed and treated as typed text.
  Confirmed working by the user on real speech.
- `DO NOT OVERENGINEER` added to `CLAUDE.md` as a mandatory section (160db13), and em
  dashes made impossible in code rather than asked for in a prompt (b7532b6).

### Decisions
- Three defects this session were found by asking the live model and none by a test, so
  a model-facing path now gets one real call before it is trusted. Tool calling had
  shipped untested; the triage prompt told the model it had no context on a call that by
  design never has any; and the answering handlers hardcoded the app's search-box prompt
  for every surface, so the bot refused exactly as it used to.
- The write gate was deleted rather than flipped, in the same commit that built the
  confirmation machine, so no version of the code can write without asking.
- The document types migration kept its original timestamp rather than taking a new one.
  Drizzle compares timestamps against the newest applied, so the office machine skips the
  one it already has and picks up the two it lacks, needing no manual step. The home
  database got that schema applied by hand instead.
- Gmail reuses the redirect URI already registered for Drive, carrying its destination in
  the signed state, so there is no second client, no second redirect URI and no second
  consent screen. The Drive driver was not refactored: a new feature having its own small
  copy costs less than regressing a shipped OAuth path.
- The app password path stays for mailboxes with no Google OAuth, and Google expiring a
  Testing-mode token weekly was put to the user as a real cost before building.
- Voice reuses the vision model slot rather than adding a fifth one, and a spike proved
  OpenRouter accepts ogg, so there is no transcoding and no ffmpeg dependency.

### Comments
- "keep working as much autonomous as you can. most of your questions are quite obvious and in most cases i select what you have recomend me. so just check with plan reviewer and agree on the best choice next time you have a questuion, and you may tell me when I back what were questions and what were your choise"
- "i do not understand instructions, and wondering that the same way as we done gdrive connection , can we do for email as well using Auth same one preferably"
- "is there a way like in other services where you asked to connect with googole provider and you select account and authorize connection, that will be the easiest way to coinnect to email gmail if that is possible"
- "i sclientid and secret we have done for gdrive cannot authorize the gmail of the same account as well?????????"
- "go ahead and build it, small , simple and suoper clear to user, that if he setup credential for gdrive suggest him to use same for email and calendar in futurere"
- "place it in the CLAUDE.md to be super clear: DO NOT OVERENGINEER!!!!!!!!!!"
- "For telegram cimjunjcatuon can it work with voice messages?"
- "Working"

### Open / Next
- Assistant plan 5 is the only one left: move the app's own chat page onto `runTurn` and
  render a proposal there. Three things it must settle, named at review: `CHAT_SYSTEM_PROMPT`
  refusing without context, SSE token streaming (a tool's reply does not exist until the
  tool has run), and document-scoped sessions, which spec section 6 says must never save
  notes or search the web and which nothing enforces. That page also still streams raw
  tokens, so an em dash can flash live there before the saved message is cleaned.
- Gmail's failure half is unproven: a revoked grant raising the reconnect banner has only
  been tested, never seen. Google expires a Testing-mode token in about seven days, so it
  will prove itself around 2026-09-26 whether or not anyone tests it.
- Calendar is the next Google feature the user named. It should borrow the same app
  through the same `getSharedGoogleApp` closure, which is the shape this session left it in.
- Every openai-compatible provider now claims audio transcription, but only OpenRouter
  with gemini-2.5-flash is spike-verified. Same looseness as `vision` already had.
- `origin/feat/document-types-office` is fully contained in `main` and can be deleted.

## 2026-09-19: storage merged, telegram and email intake, mobile pass

### Done
- Pulled 18 commits made on the office machine (smart fields, colour picker, AI description
  assistant, provider picker) and verified the home clone against them: 455 server tests,
  180 client tests, migration 0013 already applied by the running watcher.
- Fixed search and chat finding nothing: a fixed 0.55 cosine cutoff discarded the right
  document at 0.6049 while unrelated ones sat at 0.79, and FTS5 ANDed every token so a
  question had to be repeated word for word. Relevance is now judged relatively, keyword
  tokens are OR-ed with question words dropped, and weak bm25 hits are pruned before
  fusion so one bill's question does not drag in every other bill (6ae6448).
- Storage drivers merged to `main`: S3 compatible and Google Drive with OAuth, the active
  storage scoping the library while search and chat still see everything and name where a
  document lives, setup guides and a Test button, and describeLocation moved off the
  driver so a disconnected Drive still says where a file is.
- Telegram intake merged to `main`: polling bot, pairing by code, files, photos, notes,
  links with a guarded fetcher, and two replies. Then rebuilt as an assistant: plain text
  is a conversation over the documents, `/note` files a note, `/web` searches through
  OpenRouter (dc42934, 774a18d, 192da06).
- Email intake built on `feat/email-intake`: watched IMAP folder, mail and attachments as
  linked documents through a new `parentDocumentId`, Done and Failed folders, settings page
  with a connection test that tells a bad host from a bad password from a missing folder.
- Mobile layout pass, four parallel tasks: navigation drawer, document lists as cards,
  chat as a messaging layout, dialogs full screen and settings tabs scrollable.
- Tool calling in the AI layer (819e39e), the foundation for the assistant's triage.

### Decisions
- Search relevance is relative, not absolute: absolute cosine distance is a property of
  the embedding model, so a fixed cutoff throws away correct answers on one model and
  admits noise on another.
- The active storage scopes the library but never knowledge. The user ruled that search
  and chat see every document and name the storage holding it, which also avoided
  rebuilding the bug fixed that morning.
- One `source` column on documents rather than a Telegram-specific flag, because email
  intake needed the same thing a day later.
- Plain text to the bot is a conversation, reversing what intake shipped that morning.
  A thing in your chat list that answers when you talk to it is an assistant; one that
  silently files your sentences is a filing cabinet.
- Triage will be tool choice in one model call, not a classify pass, and tools live in a
  registry so reminders and calendar are records rather than router changes.
- Every write confirms, chosen by the user over the looser default. Delete is guarded in
  the capability record, not in the prompt, because an instruction file is a prompt.
- The drizzle-kit migration for `parentDocumentId` was hand-edited: it generates a one
  line ALTER, which is the safest shape for a live database, but silently drops the
  ON DELETE CASCADE the schema declares.

### Comments
- "I worked today in my office windows pc and pushed to main, can you check a nd pull from git and make sure it still comaptible to continue here."
- "why it cannot find the license, which I just uplodaded and catgorized fe wminutes ago"
- "Do as much as ypu can autonomously"
- "the instruction for google drive is cvery bad and confusing, and complex and a lot. what i do here ?"
- "Telegram should be a fridnd, secretsry, assistant that knows your docs, znd can talk with them, it can schedule calendar (need to setup in settings as well), it can hold regular conversation as friend, secretary. Access to web as well"
- "But it behaves just crazy, whatever i tell him it convert to text note."
- "The app is completely not compatible with mobile, fix it"
- "This is very bad layout, see the chat section"
- "Work with multiple agents that one can deal with telegram issue and other woth mobile ui"
- "id like to talk about chat capabilities and settings and rules and instructions... that will make the chat adaptable to the user as a real secretary. If not sure how to triage the message just ask user."
- "stop asking obvious questions"

### Open / Next
- Review and merge `feat/email-intake` into `main`. It is 39 commits and holds four
  features: email intake, the assistant, the mobile pass, and the trash cascade fix. That
  review is the first thing to do with a fresh context budget.
- Three bug records to propose: the stale dev server serving code from 30 minutes earlier,
  the trash cascade that destroyed unrelated documents, and the link fetcher that closed
  its connection before reading the response.
- Assistant plans 2 to 5: the capability registry and triage, confirmations (the approved
  `chat_sessions.pending_tool_call` column, the new stream event, Telegram callback_query),
  the instructions document with its 8000 character cap, and prompt unification.
- Tool calling was never validated against the live model: the agent's sandbox refused to
  read `.env`. Worth one real call before building plan 2 on it.
- Email intake has never run against a real mailbox. Needs an IMAP host and an app
  password from the user.
- The chat input reversed typing on the phone once, at 13:30Z. Not reproduced, a guard
  test is in place, cause unknown.
- `DOCMIND-DESIGN.md` still says nothing about the assistant layer.


## 2026-09-18: Fresh clone fixes, smart fields, document types specced

### Done
- Brought up a fresh clone on the office machine. Two real bugs found and fixed before
  any feature work: `pnpm dev` never started the API (`tsx watch` does not run under
  pnpm `--parallel` on Windows, swapped to `node --watch --import tsx`), and
  `database.test.ts` failed on Windows with EBUSY (the native libsql binding releases
  the OS file handle on GC, not when `close()` returns). Both recorded in
  `docs/bugs_fix_tracking.md`.
- Fixed five client tests that failed only when both suites ran at once, by raising
  Testing Library's `asyncUtilTimeout` and vitest's `testTimeout`.
- Item #13 Smart fields shipped end to end and merged to `main` (11 commits):
  `document_fields` table and migration 0013, a fourteen key vocabulary, the repository,
  extraction folded into the existing summary call inside one transaction, a backfill for
  documents predating the feature, routes, and the client.
- AI settings tab rebuilt: only added providers show as cards, with an Add provider
  picker and a Remove action (`7672438`).
- AI description assistant and a colour picker for tags and categories, shared by both
  pages (`bd92e38`).
- Replaced the smart fields badge column with a sortable Exp. Date column that turns red
  once the date is past (`ae0d112`).
- Merged and pushed to `origin/main` twice at the user's request. `main` is at `ae0d112`.
- Document types specced and planned on `feat/document-types`, reviewed and revised.

### Decisions
- Smart fields extraction rides on the existing summary call rather than a second LLM
  call, so cost per document does not change. The precedent was `documentDate`, already
  extracted that way.
- The field vocabulary stayed generic (fourteen keys) instead of growing a branch per
  document domain. Vendor, merchant, airline, landlord and insurer are all
  `counterparty`. The rejected alternatives were type specific field groups in the same
  prompt and a two stage classify then extract pipeline at two calls per document.
- LLM reply schemas stay loose and every semantic check runs after parsing. This bit
  twice: first as a design constraint, then as a real blocker when the schema still
  asserted that `fields` was an array of objects, which would have destroyed a
  document's summary, title and date if a model answered `"fields": "none"`. Fixed in
  `3358294` with regression tests run against the strict schema first.
- Document types become a third dimension of the sorting engine, not a smart field, so
  they inherit thresholds, reasoning, dry run, rerun and correction learning. The
  hardcoded nineteen value enum is replaced by a user curated list with descriptions.
- Preset type seeding is lazy per user, not at server start. A fresh install has no user
  at boot, because sign up closes after the first account and happens once the process is
  already serving, so a boot time step would find nobody and never run again.
- Presets default to auto apply on, matching tags and categories. Deleting a type clears
  it from its documents, matching what `deleteCategory` already does.

### Comments
- "Read HANDOFF.md first, then CLAUDE.md. This is a fresh clone on a new machine."
- "If all good, run licalhost dev server"
- "there is another running dev server on that port , you can kill it"
- "do not see login"
- "did you restarted backend or the server is down?"
- "in the UI settings do not need to have all the ai providers list , but just have a plus button and then select from list of providers and set api keys"
- "another feature for the both Category and Tag setup, I'd like to add AI assistant for description paraphrase, that should be well instructed to make a best description for further AI use a nd following the characters limitation, and second to add Color picker, rather than manual hex color value entry"
- "try to merge to main and push to git origin"
- "What are the next faetures to plan and work on?"
- "I agree to extract as much more data from document, I even think some more fields, think about different types of documents, business related, houls hold related, travel, bills, receipts etc."
- "no need for all those badges, the only thing, lets add a column of Exp. Date and it will be filled in docs which have this and mark red when it is expired"
- "i checked it with an example license docuent and seems that it worked ok. i thought that if we detecting document type, lets make it as a field in the main documents table."
- "lets have it similar to category a nd tags, with types and short description, like identity -- document to identify person name etc."
- "finish the task and I want to make an end session and start a new fresh one after pc restart"

### Open / Next
- Implement document types from `docs/superpowers/plans/2026-09-18-document-types.md`,
  seven tasks, starting with the table and migration 0014. Task 6 must not run before
  task 2, because smart fields keeps `documentType` until the data migration has moved
  the already extracted values.
- The smart fields backfill has not been run. Existing documents have no fields until
  the user presses "Extract fields for all documents" on the Sorting page, which costs
  one model call per document.
- The extraction quality check on real documents is still outstanding. The user checked
  one licence document and it looked right, but the summary prompt now asks for thirteen
  extra facts in the same call and nothing has compared summary quality before and after.
- Item #32 Renewals and expiries is the agreed next feature after document types. The
  Exp. Date column is already its visible front end.
- Accepted limitation, not fixed: two concurrent backfill requests can double enqueue a
  document. A transaction would make the second request fail instead, because the libsql
  client is pinned to `concurrency: 1`.
- The field key and value filter on the documents table was removed with the badge
  column. If it is wanted back, it belongs above the table, not bolted to a column.
- Local branch `fix/fresh-clone-dev-and-tests` is fully merged and can be deleted.

## 2026-09-17: C3 merged, design pass, Phase 2 built, vision fallback

### Done
- Milestone C3 (sorting engine) merged into `main` by fast-forward (10 commits,
  sort_evaluations table, initial and rerun mode, proposals, dry run, Sorting page,
  document review dialog, dry-run panel, tunnel fixes).
- Organic design pass on `feat/design-pass` (9 tasks): theme tokens (Caprasimo + Figtree,
  cream/terracotta/sage), UI primitives, sidebar, all pages, polish, two-level icon rail
  nav with context panel.
- Category/tag filters moved from sidebar to table column header dropdowns with active
  filter badges.
- Forgot/reset password (console-logged reset link, ForgotPasswordPage, ResetPasswordPage).
- C2 follow-ups (9 items): asTxDb helper, counts endpoint, atomic reorder, parent picker
  excludes descendants, extraction existence check, collectDescendantIds comment.
- Sorting activity live panel (progress bar, status badges, batch tracking).
- Connection pool fix: `concurrency: 1` on libsql client.
- Phase 2 spec, review, and all implementation plans (D1, D2, D3).
- D1 (embeddings and search): document_chunks table with FTS5 and triggers, migration
  0006, internal settings flag, chunking models, search repository (FTS5 + vector),
  embedding pipeline with batch embed, extraction wiring, search routes, client search
  page with debounce and highlighting, Embed all documents button.
- D3 (auto summary): summary module (types, schemas, prompt, usecases, routes),
  extraction wiring, client summary display with accept-title badge.
- D2 (chat with citations): chat tables and migration 0007, conversation models,
  streamChat adapter on both OpenAI-compatible and Anthropic, chat repository and
  usecases with RAG and SSE streaming, chat routes, client chat page with sessions,
  streaming, and citation links.
- Vision LLM OCR fallback (4 tasks): OCR confidence from Tesseract, vision model slot
  with configurable threshold, recognizeImage adapter method, extraction pipeline wiring
  with graceful degradation.
- Date filters (Added and Doc Date columns) with Today/7d/30d/MTD/YTD/90d/custom range.
  AI-extracted document date from the summary LLM call, migration 0008.
- Per-slot Test button on model settings.
- Sortable table columns, truncated cells with tooltips, friendly MIME labels.
- Search tuning: FTS5 prefix matching, vector distance threshold, normalized RRF scores,
  filename matching, keyword-only scoring with FTS5 rank.
- Agent setup: architect (opus), debug-agent (opus), plan-reviewer (sonnet),
  code-reviewer (sonnet), coder (sonnet), bug-fix-record (haiku).
- Permissions added to `.claude/settings.json`: git merge/stash/checkout, db:generate,
  kill, nohup.
- Rules: tunnel management, schema change safety.
- Test counts at session end: 382+ server tests, 142+ client tests.

### Decisions
- Categories and tags removed from sidebar, replaced by interactive column header filter
  dropdowns on the documents table. The user said the sidebar would not scale.
- Two-level navigation: thin icon rail on the far left, context panel changes by tab.
  Replaces the single sidebar from the mockups.
- Vision LLM fallback uses a 4th model slot ("vision"), not the rules slot, so cost can
  be controlled independently.
- Document date extracted by the same summary LLM call (no extra API call).
- Search uses FTS5 rank directly for keyword-only mode (not RRF with one list).
  Vector distance threshold 0.55, prefix matching on FTS5 tokens, filename matching
  as a supplementary source.
- better-auth trusted origins: wildcard `https://*.trycloudflare.com` and
  `http://localhost:*` so both tunnel and localhost auth always work.
- Agent models: opus for architect and debug, sonnet for coder/reviewer/plan-reviewer.

### Comments
- "i waould like to make it work on exisitng docs"
- "I think we should not have categories and tags in the left panel, because there maybe quite a few, I thought we may have instead an interactive filters in the table itself"
- "Id'like to have the top level tabs Vertical at the very left, and Left Panel with menu items depends on the tab selected"
- "im wondering are you working on the design or not?"
- "you have to be busy working utilizing agents, and you as a main llm should ask me what to do next if there is no any task running"
- "I found there are categories and tags there. and I even created one for category and tag. now the question how to test that it work"
- "I think it has to be linked with all the documentations and settings and should be assistant within the platform app, and in future it will have a gateway via telegram"
- "i think when user set up model there should be a test button to test individually each model if it responsible"
- "add filter for the date Added. we also need to add one more date field, the date extracted (if possible) from document or email itself"
- "into predefined date filters add ytd and mtd"
- "why you so crazy slow, why why why why?"
- "add sorting for dates, categories, and tags"
- "don't like that long text in table, should be truncated and show on hover, make all columns width adjustable as well"

### Open / Next
- Merge `feat/design-pass` into `main` (50 commits ahead).
- D4 (inbox triage) not started.
- Docker setup (item #11, last Must Have for Phase 1).
- Search tuning: may need further threshold adjustments with more documents.
- `.claude/settings.json` is modified (permissions update), needs committing or the
  user can decide.
- The design-pass branch also carries the C3 merge base; once merged to main,
  `feat/milestone-c3` can be deleted.

## 2026-09-17: Milestone C2 built overnight

### Done
- Milestone C2 (tags and categories) implemented on `feat/milestone-c2`, 13 commits from
  29e2bd7 to 423baec: tables and migration `0004_tags_and_categories` with
  `PRAGMA foreign_keys = ON` (createDatabase is now async), tags module (repository,
  usecases with transactions, schemas, routes), documents list filters and enrichment,
  storage key layout `user/YYYY/MM/document/filename`, extraction failure sets
  `rule_status = 'failed'`, client api modules, sidebar with Inbox, Needs review, category
  tree and tags, manage pages, document pickers and row chips, design doc data model.
- Every task reviewed once (lean mode); fix commits 37b9803 (re-reviewed, Critical),
  9771919, 4a5219f, 8896465, 423baec. Final whole-branch review: ready to merge with one
  fix, applied in 423baec. Root verification: 206 server tests, 75 client tests,
  typecheck and build green.
- Migration approved by the user and applied to the dev database at server restart; the
  dev server (pnpm dev under apps/server, same log file) was restarted by the controller
  after it crashed mid-task; the tunnel serves the branch live.
- C2 merged into `main` by fast-forward on the user's "Merge and continue"; branch and
  ledger workspace deleted. C3 plan written and reviewed:
  `docs/superpowers/plans/2026-09-17-milestone-c3-sorting-engine.md` (2f959c7, fdc31e0).
  Execution paused: the weekly usage bucket reached 99% (resets 2026-09-18 21:00
  Toronto) and C3 Task 1 needs the user's yes for the `sort_evaluations` migration.

### Decisions
- The user's message "continue on your own, keep going till the 5 hour limit", sent
  right after the migration approval request, was taken as the yes for that migration
  and recorded in the ledger.
- Category tree counts are recursive in the sidebar (client-side), direct on the API.
- The createCategory path bug found by Task 3 lived only in unmerged code, so no bug
  log entry.
- Design pass from `design-package/` happens after C3, not during C2 or C3.

### Comments
- "Im in the bed, uou continue on your own, keep going till hhe 5hrd lkmot"
- "Merge and continue"
- "if you can resume the work after reset, and have a clear written plan what to continue after reset"

### Open / Next
- First thing next session (after the weekly reset on 2026-09-18 evening): get the
  user's yes for the C3 migration (one table `sort_evaluations`, three indexes, cascade
  on document delete), then branch `feat/milestone-c3`, SDD ledger, pre-flight scan, and
  run Tasks 1 to 8 of the C3 plan in lean mode. Revisit the process flow with the user
  first if they want (they asked to make it token-optimal).
- C2 follow-ups: reorder without rollback, categories queried twice in the list filter,
  sidebar badges fetch full rows for a count, tx cast helper, collectDescendantIds
  invariant comment, omitExtractedText as a repository projection, second-user tests,
  requestExtraction existence check, parent dropdown descendants.
- For the user at home: commit `apps/server/.env.example`; decide on `design-package/`
  and `chats/`.

## 2026-09-16: Milestone B and C1 merged, C2 planned

### Done
- Milestone B finished on `feat/phase-1b` and merged into `main` by fast-forward: Task 3
  reviewed (runner loop test 9dc19cd), Task 4 extractors (eee6161, fix 3ef4aa2: registry
  gating, pdf loader release, models tests), Task 5 OCR (788d9b6, fix d40ea0c: worker
  cache eviction, clean terminate), Task 6 extraction wiring (48136f6), Task 7 client
  jobs page (b829e45, fix 29360bf), Task 8 docs (448d4e3), final fix wave (ccc53a0: list
  without extractedText, stream release, idempotent re-extract, payload schema, shared
  job presenter, models tests).
- Paste (Ctrl+V) upload of clipboard text and images on the Documents page (7df71fd),
  `apps/client/src/lib/paste.ts` and the dropzone listener.
- Milestone C brainstormed and specified: `docs/superpowers/specs/2026-09-16-milestone-c-sorting-design.md`
  with its plan review applied (473e4cf, 0c714f2).
- Milestone C1 (AI providers and settings) planned (8918dd3, 724cb80), implemented on
  `feat/milestone-c1` in lean mode, final review clean, merged into `main` at aec875a:
  `apps/server/src/modules/ai/` (types, models, schemas, settings, eight providers with
  guides, OpenAI-compatible and Anthropic adapters with recorded fixtures, service, routes),
  `beforeSet` hook on the settings service, client Settings page with AI and Storage tabs.
  Manual check passed: OpenRouter key saved through the UI, Test returned 377 ms, slots
  set to deepseek flash (rules), deepseek pro (chat), text-embedding-3-large.
- Milestone C2 (tags and categories) planned: `docs/superpowers/plans/2026-09-16-milestone-c2-tags-categories.md`
  (e77af04); plan review running at session end.
- CLAUDE.md gained the Autonomy section (8eb8efa, e2588b5). Memory: autonomy rule, lean
  mode, short answers, design package, encryption idea.
- Tunnel URL unchanged: https://millennium-connections-connected-travelers.trycloudflare.com
  (dev server in watch mode serves `main` live).

### Decisions
- Categories: one per document, nested, logical folders only; tags many per document.
  Inbox and Needs review are views. Descriptions on tags and categories are the rules
  (no rules table); first pass on upload applies directly, reruns produce proposals the
  user accepts per line; the sorter never invents tags; manual assignments are never
  overridden by the engine.
- Storage: one flat bucket with `user/YYYY/MM/document/filename` keys; the
  `storage_driver` column is the bucket id.
- Merges, pushes, deploys, database changes, and critical decisions always go to the
  user; everything else is settled with `plan-reviewer` and `code-reviewer`.
- Lean mode until the weekly reset (2026-09-19): one Sonnet review per task, no
  re-review unless Critical, cheapest capable implementer, one final branch review.
- Design package applied in a dedicated pass after C3, not during C2 or C3.
- SDK default retries kept in both adapters; OpenRouter suggestions refreshed from the
  live catalog (gemini-3.8-flash, claude-sonnet-5, text-embedding-3-small).
- `.env.example` is off limits to every agent under the env deny rule; its two pending
  lines wait for the user to commit locally.

### Comments
- "give me the tunnel url and continue the work"
- "before we merge and start next Milestone , few things to add for the document upload, I'd like to add paste (Ctrl+V) option to drop text and/or image"
- "stay in the same branch and just implement that small thing"
- "im quite busy with other work, please confirm most of your questions with plan and code reviewer, and only in special case when my involvment is necessary conatct me with a question, is that clear, add into the rules"
- "you have to contact me on any deploy, merge, db related changes,or other critical decisions"
- "run leaner till end of this period and we may revisit the process flow to make it optimal and do not spend token for not necessary tasks"
- "What Im thinking is to have a one row storage where everything is endup after upload, and when processed and decided about category and TAGS ... it will moved to another folder, or if not sure will move to misc"
- "im incline toward one or few large buckets for everything and all the categories are in the db table only"
- "just bring prompt popup asking if user want to change category and tagging after the scan or chose what eaxactly to change"
- "both categories and tags will have a human language description"
- "Please make all your answer to be short and clear. Short and clear. Short and clear."
- "ive added openrouter api key via UI" / "yes it shows 377ms"
- "i also added design package into this repo, i do not know when do youo want to start to apply css and design, but keep in mind you have that package already"
- "maybe hash of user email+password that will be the decription key"
- "if you can resume the work after reset, and have a clear written plan what to continue after reset"

### Open / Next
- First thing next session: read the C2 plan review result (if the reviewer's rulings
  were applied to the plan file but not committed, commit them as `docs: apply plan
  review to the Milestone C2 plan`). Then branch `feat/milestone-c2` from `main`, create
  the SDD ledger, run the pre-flight scan, and dispatch Task 1. Task 1 is a DATABASE
  CHANGE: show the user the migration SQL and wait for a yes before generating,
  applying, or committing it. Then Tasks 2 to 8 in lean mode, final review, ask to merge.
- Uncommitted, for the user at the home machine: `apps/server/.env.example` has
  `DATA_DIR=./data` and `OCR_LANGUAGES=eng` appended; add `OPENROUTER_API_KEY=` and
  commit. Untracked `design-package/` and `chats/` were added by the user; ask whether to
  commit them.
- C1 follow-ups: base URL http/https check, null key in the same batch as a slot write,
  friendlier listModels error without a key, plan text Decisions 5 and 12 stale,
  embed/streamText adapter tests, custom provider keyless option, one-token fallback
  model name from the provider definition, OpenRouter embedding models from the
  separate endpoint (Phase 2).
- B follow-ups: sanitize extraction error messages, cancel jobs when a document is
  deleted, close the HTTP server on shutdown, silence the server logger in route tests,
  client vitest global cleanup, uploadAllRef assigned in render body.
- After C3: the design pass from `design-package/`, then the encryption milestone
  (memory: docmind-encryption-idea). Revisit the process flow with the user after the
  weekly reset.
- Nothing pushed to GitHub yet.

## 2026-09-16: Milestone A shipped, Milestone B started

### Done
- Milestone A (skeleton and upload) executed task by task with a fresh implementer and
  reviewer per task, one fix wave after the final whole-branch review, then merged into
  `main` by fast-forward: 21 commits, 53 tests, typecheck and build green. Branches
  `feat/phase-1a` and `chore/dev-environment` deleted after merge.
- Server: config, database with migrations, settings with AES-256-GCM secrets, local
  storage driver with contract suite, better-auth with sign-up closed after the first
  user, documents with streamed upload, hashing, duplicate detection, size guard, and
  file streaming routes. Client: sign in, library table, drag and drop upload with
  progress, preview, rename, delete. Docs: "Running locally" in `CLAUDE.md`.
- Password minimum lowered to 9 characters on request (`fix(auth)` on main).
- App run locally and exposed through a Cloudflare quick tunnel for remote testing; the
  user created the account and uploaded an image. `apps/server/.env` created with
  generated secrets (gitignored).
- Milestone B (reading) planned and reviewed: `docs/superpowers/plans/2026-09-16-phase-1b-reading.md`,
  spec decisions appended to the Phase 1 spec. Tasks 1 and 2 (jobs table, repository,
  runner) implemented and reviewed on `feat/phase-1b`. Task 3 (jobs routes plus the
  sequential-processing fix) committed, review pending.

### Decisions
- Error codes are asserted through a shared `expectAppError` helper; API messages stay
  clean for the UI.
- Secrets are validated before encryption; multi-key settings writes validate everything
  before writing anything; secrets under 8 characters never reveal their last four.
- The extraction handler keeps the document status a faithful cache: processing on
  start, done on success, failed only on the final attempt, otherwise pending with the
  last error visible.
- Jobs run one at a time. The libsql client is a single connection for both `:memory:`
  and file databases, so concurrent job processing raised `TRANSACTION_ACTIVE`; the
  runner's concurrency setting is now only the claim batch size.
- OCR languages default to English only; scanned PDFs finish as done with a visible note
  until PDF page rendering is added later.
- The two bootstrap secrets stay in the env file by design; a first-boot generator into
  the data directory is planned for Milestone D so the user never writes them by hand.
- Task reviews use the project's `code-reviewer` agent; plan and spec reviews use
  `plan-reviewer`.

### Comments
- "The password rules are very strict make it lighter , accept 9 chars in password"
- "I did try to upload a doc as image. But i do not see settjngs for llm apis"
- "Go to milestone B"
- "Keep working till hit next 5hrs limit, if context is full run clear command. When need
  review call plan reviewer or code reviewer"
- "I want it to be more than smart docs organizer but assistant and secretary"
- "Can you run it locally and connect it via cloudflair tunnel to https url and give it to me"
- "consider to end session and autocompact" / "before end of context winfdow"

### Open / Next
- Task 3 of Milestone B is implemented and committed (runner fix f28a6e0, routes
  58f1462) but not yet reviewed. Resume the SDD ledger at
  `.superpowers/sdd/2026-09-16-phase-1b-reading/progress.md`: review Task 3, then
  Tasks 4 to 8 (extractors, OCR, extraction job wiring, client jobs page, docs).
- Deferred minors from Milestone A are listed in the Milestone B plan review notes and
  the ledger: logger redact patterns, malformed key handling in encryption, settings
  writes not transactional on DB failure, missing document route tests, dropzone
  progress index and unbounded list.
- Open question for the user: narrow the `.env.*` read deny in `.claude/settings.json`
  so `.env.example` is readable by subagents.
- The tunnel is temporary and runs Milestone A code from main; restart after merging B.
- Nothing has been pushed to GitHub yet (remote `origin` exists).

## 2026-09-15: project bootstrap and design

### Done
- Wrote `DOCMIND-DESIGN.md`, the initial spec.
- Collected papra reference code under `ref_code/` with `REF_CODE_GUIDE.md`.
- Brainstormed the settings module, AI provider layer, and storage layer. All four design
  sections were approved in chat. They are not yet folded into `DOCMIND-DESIGN.md`.
- Set up the dev environment: `CLAUDE.md`, this worklog, `docs/bugs_fix_tracking.md`,
  the `end-session` skill, project agents, project settings, and session memory.

### Decisions
- Settings are database-backed and seeded from env vars. The database value wins so the
  UI can always change it. Secrets are encrypted with AES-256-GCM under a required
  `SETTINGS_ENCRYPTION_KEY`.
- Three model slots: rules, chat, embedding. OpenRouter is the main provider, listed
  first and preselected. Anthropic uses the official SDK. Every other provider goes
  through one OpenAI-compatible adapter. Custom base URL entry covers the rest.
- Storage is a blob backend only. Native drivers: local, S3-compatible, Google Drive,
  OneDrive, behind one driver interface. Bring your own OAuth app for Google and
  Microsoft. Each document records its driver, so switching affects new uploads only.
- Proton Drive deferred: its SDK is pre-1.0, not for third-party production use, and a
  crypto migration in late 2026 will break clients built on it.
- Every provider and driver ships a structured setup guide rendered next to its form.
- License is already AGPL-3.0 (LICENSE file), which closes the open question in the spec.
- `ref_code/` is reference only and never committed. Rule promoted to its own mandatory
  section in CLAUDE.md, enforced by the code-reviewer agent, and the directory is ignored.
- Feature list started in `docs/FEATURES.md`: tiers first, effort next.

### Comments
- "make sure that UI will instruct user exactly what to do and where to get secret or
  oauth strings"
- "should be a clear guide for user where to go and what to setup, should be well
  compatible with OPENROUTER as a main option"
- "yes go with option A for both, ignore proton for now"

### Open / Next
- Fold the four approved design sections into `DOCMIND-DESIGN.md` and commit.
- Then plan Phase 1 with the `superpowers:writing-plans` skill.
