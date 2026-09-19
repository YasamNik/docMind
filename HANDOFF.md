# DocMind: Agent handoff, 2026-09-18

Read this file first when starting a new session on a fresh clone.

## What happened

Session on 2026-09-17 and overnight 2026-09-18 shipped Phases 1 and 2 completely, plus
11 Should Have features. The codebase is on `main`, 167 commits ahead of origin. All
389 server tests and 145 client tests pass. Typecheck is green on both apps.

### Features shipped this session (on main)

| Item | Feature | Status |
|------|---------|--------|
| 11 | Docker (Dockerfile, compose, SPA serving) | Done, closes Phase 1 |
| 23 | Inbox triage (triageStatus, accept flow, evaluations) | Done, closes Phase 2 |
| 33 | Dark mode (warm organic palette, theme toggle) | Done |
| 33 | Keyboard shortcuts (Cmd+K search, g+key nav) | Done |
| 27 | Trash with restore (soft delete, purge) | Done |
| 26 | Bulk actions (multi-select, batch tag/category/delete/sort) | Done |
| 28 | Saved searches (CRUD, sidebar, auto-populate) | Done |
| 29 | Export/backup (zip with metadata + files) | Done |
| 31 | Failure notifications (failed count badge, red dot) | Done |
| 24 | Rules learn from corrections (examples in prompt) | Done |
| 25 | Rule suggestions (AI proposes rules from documents) | Done |

### Migrations added (all on main, auto-run on server start)

| # | Name | What |
|---|------|------|
| 0009 | add_triage_status | triageStatus column on documents, backfill existing to reviewed |
| 0010 | add_deleted_at | deletedAt column on documents for soft delete |
| 0011 | add_saved_searches | saved_searches table |
| 0012 | add_rule_examples | rule_examples table for correction learning |

## Setup on a new machine

### Prerequisites

- Node 22: `nvm install 22 && nvm use 22`
- pnpm: `corepack enable && corepack prepare pnpm@10.12.1 --activate`
- Docker (optional, for container deployment)

### Clone and install

```bash
git clone <your-repo-url> docMind
cd docMind
pnpm install
```

### Environment

```bash
cp apps/server/.env.example apps/server/.env
# Edit apps/server/.env and fill in:
#   SETTINGS_ENCRYPTION_KEY (openssl rand -hex 32)
#   AUTH_SECRET (openssl rand -hex 48)
```

If migrating from the home machine, copy these files instead:
- `apps/server/.env` (has your secrets and API keys)
- `apps/server/docmind.sqlite` (your database with all documents, settings, users)
- `apps/server/documents/` directory (uploaded files on local storage)

### Run

```bash
pnpm dev              # server on :4000, client on :5173
```

Server auto-runs all migrations on start. First visit: http://localhost:5173.
If fresh install (no copied database), sign up creates the single account.

### Tunnel for remote access

```bash
cloudflared tunnel --url http://localhost:5173
```

Auth is pre-configured to trust `*.trycloudflare.com` origins.

### Verify

```bash
pnpm test             # 389 server + 145 client = 534 tests
pnpm typecheck        # both apps
```

## What to work on next

Read `WORKLOG.md` for the full session log. Read `docs/FEATURES.md` for the roadmap.

### Immediate (Should Have, no external services needed)

- **Item #13: Smart fields** - Extract dates, amounts, parties, document type from
  documents. Needs a new table and LLM extraction step.
- **Item #30: Move documents between storage drivers** - Follow-up from the storage
  design. Pure server logic.

### Phase 3: Intake from anywhere (items 15-19, 9)

- **Item #15: Telegram intake** - Personal bot, needs a Telegram bot token
- **Item #16: Notes with sections** - User-defined sections, AI-sorted notes
- **Item #18: Email intake** - IMAP watcher, needs email credentials
- **Item #9: S3/Drive/OneDrive storage** - Additional storage drivers with OAuth

### Process reminders

- Read `CLAUDE.md` for all conventions, workflow, and autonomy rules
- Feature branches off `main`, never commit directly to `main`
- `code-reviewer` agent before every commit
- `plan-reviewer` agent before implementation starts
- Ask the user before merges to main, pushes, and database changes
- No em dashes anywhere

### Known issues

- `.claude/settings.json` may need permission updates for git and pnpm commands
  on a fresh machine. The user has a memory note about this.
- The export feature (item #29) does export only, import is not yet implemented.
- The Docker SPA serving resolves paths from `import.meta.url`, not CWD. This is
  correct but means the Docker WORKDIR must stay at `/app/apps/server`.

## Files to read

| File | Why |
|------|-----|
| `CLAUDE.md` | How we work: conventions, agents, workflow |
| `DOCMIND-DESIGN.md` | The spec: vision, stack, architecture |
| `WORKLOG.md` | Session log, newest first |
| `docs/FEATURES.md` | Full feature list and delivery phases |
| `docs/bugs_fix_tracking.md` | Bug and fix history |

## Switching between machines

The project is developed on two machines (home Linux, office Windows) that sync only
through `main` on GitHub. These things do NOT travel with a push:

| Per machine, untracked | Why it matters |
|------------------------|----------------|
| `apps/server/.env` | Secrets and API keys, different on each machine |
| `apps/server/docmind.sqlite` | Each machine has its own documents, settings, user |
| `apps/server/documents/` | Uploaded files on local storage |
| `apps/server/data/` | OCR language data, downloaded on first image upload |

### Arriving on a machine

```bash
git fetch
git status -sb                 # confirm ahead/behind, expect a clean fast-forward
git merge --ff-only origin/main
pnpm install                   # only if pnpm-lock.yaml changed
pnpm typecheck && pnpm test
```

Then check three things:

1. **Migrations.** `git diff --name-only <old-sha> HEAD -- apps/server/drizzle/`. If the
   dev server was running during the pull, its watcher already applied them to the local
   database. Verify the new tables exist before assuming the app works.
2. **Stale dev servers.** `ps -ef | grep docMind`. Watchers from earlier sessions can
   survive for days, fight over port 4000, and write to the same SQLite file. Keep one
   server and one Vite, kill the rest.
3. **Tunnel.** `curl -s -o /dev/null -w "%{http_code}" <tunnel-url>` must return 200.
   The live quick tunnel hostname can be read from the cloudflared metrics port:
   `curl -s http://127.0.0.1:<metrics-port>/quicktunnel`.

### Leaving a machine

Commit and push `main`, and make sure nothing important is left untracked. Anything
uploaded through the UI stays on that machine only.
