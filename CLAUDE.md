# DocMind: working notes for Claude

Intelligent document manager: upload any document, extract its text, tag and categorize
it with plain English rules, search it (keyword plus vector), and chat with it over RAG.
Solo developer project (Yasam, GitHub YasamNik). License: AGPL-3.0.

**New here?** Read `DOCMIND-DESIGN.md` first. It is the spec: vision, stack, data model,
module layout, build phases. Then read the top entry of `WORKLOG.md` for where things
stand right now. This file is the quick reference for how we work.

## Reference code is reference only (mandatory)

`ref_code/` holds selected source from papra (papra-hq/papra, AGPL-3.0). It is there to
learn patterns from, nothing else.

- Read it to understand an approach, then close it and write DocMind's version from
  the requirements in `DOCMIND-DESIGN.md`.
- Never copy and paste from it. Never translate a file line by line into a new file.
  Never lift prompt text, error strings, schemas, or test fixtures verbatim.
- Never import from it or add it to any build, test, or tooling path.
- It stays untracked (see `.gitignore`). It is never committed to this repository.
- When a DocMind module is clearly informed by a papra pattern, say so in a one-line
  comment at the top of the file naming the pattern, not the code.
- If a piece of papra code seems impossible to do differently, stop and raise it with
  the user instead of copying it.

The point is that DocMind's code is DocMind's own and carries no licensing question,
whatever license DocMind ends up under.

## DO NOT OVERENGINEER (mandatory)

The user said this on 2026-09-19, with ten exclamation marks, after a one button feature
came back as a 504 line spec with two new shared directories, a new endpoint and a
refactor of working code. Read it as a standing instruction, not a mood.

**Build the smallest thing that does what was asked.** Then stop. A feature the user
described in one sentence should not arrive with an abstraction layer attached.

What overengineering looks like here, all of it real:

- Extracting a shared unit because something is used twice. Twice is not a pattern.
  Wait for the third, and even then only if the duplication actually hurts.
- Refactoring working, shipped code so a new feature can reuse it. The new feature can
  have its own small copy. A regression in a path the user depends on costs more than
  duplication ever will.
- A new endpoint, table, column, setting or module when an existing one would carry it.
- Options, flags and modes nobody asked for. Every one is a thing to configure, document,
  test and get wrong.
- Structure built for a future that has not arrived. Build for what is on the table today.
- A plan or spec longer than the code it describes.

**The test before you add anything:** can I name the thing that breaks today if I leave
this out? If the answer is a future maybe, leave it out.

**Scaling is per task, not per file.** A one line fix gets a one line fix, not a
refactor of the function around it. Fix what was asked, mention anything else you saw,
and move on.

This outranks tidiness, symmetry and reuse. It does not outrank correctness, the guards
that exist for safety, or the tests this file already requires.

## Session workflow

1. **Start.** Read the top `WORKLOG.md` entry. Run `git status` and `git log --oneline -10`.
   Give a two or three line recap and confirm what to work on.
2. **Work.** On a feature branch: `feat/<short-name>` or `fix/<short-name>`. Never commit
   directly to `main`. Small commits that each leave the tree working.
3. **End.** Run the `end-session` skill (`/end-session`) when the user says they are done,
   asks to wrap up, or the conversation is clearly closing. It appends the WORKLOG entry,
   saves session memory, proposes bug records, and commits the log. It never pushes.

## Autonomy (set by the user on 2026-09-16)

The user is often busy with other work. Do not wait on them for routine decisions.

- Resolve design and implementation questions with the `plan-reviewer` and
  `code-reviewer` agents, record the ruling in the ledger or the spec, and continue.
- Spec review gates and plan review gates are satisfied by the `plan-reviewer` agent;
  the user reads specs and plans when they choose to, not as a blocker.
- Always ask the user before: any merge into `main`, any push or deploy, any database
  change (new table, column, migration, data fix), and any other critical decision
  (permissions, deleting data, changing what the product does). Present the change
  and wait for a yes.
- Everything else (design details, implementation choices, test strategy, code
  review findings) is settled with the reviewer agents. Batch questions for the user
  and keep them short.
- Keep the worklog, memory, and ledger current so the user can catch up at any time.

## Stack

Details and rationale live in `DOCMIND-DESIGN.md`. Short version:

- Server: Hono on Node, TypeScript, Drizzle ORM with libsql (SQLite), sqlite-vec,
  better-auth, valibot.
- Client: React, Vite, Tailwind CSS.
- Workspace: pnpm, `apps/server` and `apps/client`.
- Tests: vitest. Unit tests for `*.models.ts`. Integration tests with in-memory SQLite
  for `*.usecases.ts`. Storage drivers share one contract test suite.

## Running locally

Node 22 and pnpm: `nvm use 22 && corepack enable`.

    pnpm install
    cp apps/server/.env.example apps/server/.env
    # fill SETTINGS_ENCRYPTION_KEY (openssl rand -hex 32) and AUTH_SECRET (openssl rand -hex 48)
    pnpm --filter @docmind/server db:migrate
    pnpm dev              # server on :4000, client on :5173, client proxies /api

Background jobs run inside the server process. OCR language data downloads into
DATA_DIR (default ./data) on the first image upload; the first OCR takes longer.

Tests and typecheck: `pnpm test` and `pnpm typecheck` from the root, or per app with
`pnpm --filter @docmind/server test` and `pnpm --filter @docmind/client test`.

After changing any `*.tables.ts`: `cd apps/server && pnpm db:generate --name <change>`,
then commit the new files under `apps/server/drizzle/`.

First run: open http://localhost:5173, create the single account. Sign up closes after it.

## Conventions

- Modules are self-contained under `apps/server/src/modules/<name>/`. Files are named by
  role: `*.routes.ts`, `*.usecases.ts`, `*.models.ts`, `*.repository.ts`, `*.config.ts`,
  `*.schemas.ts`, `*.types.ts`. Pure logic in models, orchestration in usecases, database
  access in repositories.
- Valibot for every boundary: HTTP input, env and settings, LLM output.
- LLM reply schemas stay loose, HTTP and job input schemas stay strict. `generateStructured`
  parses a whole reply in one pass and throws on any nested failure, so anything asserted
  in a reply schema can throw away the parts the model got right. That includes the shape
  of a nested array, not only the values in it. Use `v.string()` or `v.unknown()` and do
  every semantic check after parsing, dropping only the offending row.
- Drizzle for every database access. No raw SQL outside migrations and the vector table.
- Settings, API keys, and OAuth tokens go through the settings module only. Secrets are
  encrypted at rest and never logged or returned by the API.
- No em dashes anywhere: code, comments, docs, commit messages, UI copy, replies to the
  user. Use a comma, a colon, a hyphen, or a new sentence.
- Sorting cost. Every document is sorted with a single LLM call that lists every
  automatic tag and category description in the prompt. The Sorting page shows the
  count of automatic items; a very large or verbose set costs more per document to sort.
- Conventional commits: `feat(server): ...`, `fix(client): ...`, `docs: ...`,
  `chore: ...`, `test: ...`.

## Bug fix workflow (mandatory)

1. **Check history first.** Read `docs/bugs_fix_tracking.md` before investigating. If the
   bug is already there, tell the user when and how it was fixed and what the root cause
   was, then discuss how to stop it recurring.
2. **Find the root cause** with the `superpowers:systematic-debugging` skill. No fixes
   based on guesses.
3. **Write a regression test** that fails without the fix and passes with it. Run it
   against the unfixed code and watch it fail. No test, no fix.
4. **Fix**, then run the full relevant test suite.
5. **Propose recording** the fix with the `bug-fix-record` agent. Wait for explicit
   approval. Never record without it.

## Agents and skills

- `superpowers:brainstorming` before any new feature, subsystem, or design change.
- `plan-reviewer` agent on every spec or plan before implementation starts.
- `coder` agent for well-specified implementation tasks taken from a plan.
- `code-reviewer` agent before every commit. It must do regression impact analysis on
  every changed export, route, table, and setting. Do not commit until it reports no
  regression risk or the risks are addressed.
- `debug-agent` for investigating errors and unexpected behavior.
- `bug-fix-record` agent to log a fix, only after approval.
- `end-session` skill to close a session.
- Run independent agents in parallel, and in the background when the result is not
  needed for the next step.

## Git

- Feature branches, pull requests into `main`.
- Typecheck and the relevant tests pass before every commit.
- Do not push unless asked.
- Commit messages end with the attribution trailer the harness provides.

## Docs map

| File | Purpose |
|------|---------|
| `DOCMIND-DESIGN.md` | The spec. Update it when a design decision changes. |
| `WORKLOG.md` | Session log, newest first. Written by `end-session`. |
| `docs/bugs_fix_tracking.md` | Append-only bug and fix log. Written by `bug-fix-record`. |
| `docs/superpowers/specs/` | Design specs from brainstorming sessions. |
| `docs/superpowers/plans/` | Implementation plans. |
| `ref_code/REF_CODE_GUIDE.md` | What each reference directory demonstrates. |
