# DocMind worklog

Newest entry first. The `end-session` skill appends one entry per session. Each entry has
four parts: Done, Decisions, Comments (the user's words, not a paraphrase), Open / Next.

Active branch: `chore/dev-environment`

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

### Comments
- "make sure that UI will instruct user exactly what to do and where to get secret or
  oauth strings"
- "should be a clear guide for user where to go and what to setup, should be well
  compatible with OPENROUTER as a main option"
- "yes go with option A for both, ignore proton for now"

### Open / Next
- Fold the four approved design sections into `DOCMIND-DESIGN.md` and commit.
- Decide whether `ref_code/` (third-party AGPL source) is committed to the repo.
- Then plan Phase 1 with the `superpowers:writing-plans` skill.
