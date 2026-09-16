# DocMind worklog

Newest entry first. The `end-session` skill appends one entry per session. Each entry has
four parts: Done, Decisions, Comments (the user's words, not a paraphrase), Open / Next.

Active branch: `feat/phase-1b`

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
