# DocMind worklog

Newest entry first. The `end-session` skill appends one entry per session. Each entry has
four parts: Done, Decisions, Comments (the user's words, not a paraphrase), Open / Next.

Active branch: `feat/milestone-c2`

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
- "if you can resume the work after reset, and have a clear written plan what to continue after reset"

### Open / Next
- Ask the user to merge `feat/milestone-c2` into `main` (never without a yes). Then
  delete the branch and `.superpowers/sdd/2026-09-16-milestone-c2-tags-categories`.
- Then plan C3 (sorting engine, spec section 9): its Task 1 carries the
  `sort_evaluations` migration, which needs a yes.
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
