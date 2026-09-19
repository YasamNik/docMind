---
name: assistant-instructions-plan-review
description: Findings from reviewing the 2026-09-19 assistant instructions plan (plan 4 of 5), useful when reviewing plan 5 (prompt merge) or any future settings-as-versioned-document design
metadata:
  type: project
---

Reviewed 2026-09-19: `docs/superpowers/plans/2026-09-19-assistant-instructions.md` (plan 4
of the assistant spec, the instructions document). Verdict: ready after tightening three
things in the plan text, no redesign needed. See [[settings-cache-full-row-reload]] and
[[guard-tests-must-flip-the-flag]] for reusable lessons.

Key facts for later reviews of plan 5 (prompt merge) or plan 3 (confirmation):
- `chat.answerFromDocuments`'s retrieved-context block is injected as a system message
  right before the final user turn (`assembleChatContext` in `chat.models.ts`), separate
  from and after the leading system prompt message. Any decision that says "append X last
  so the model reads it most reliably" needs to account for this: appending to the leading
  system prompt string is not the same as being last in the actual messages array once
  `answerFromDocuments` injects its own later system message.
- `settingsService`'s per-user cache (`settings.usecases.ts`, `rowsFor`) loads every row for
  a user in one `listForUser` call and caches them together; a write to any one key clears
  the whole per-user cache, so the next read of any key reloads every row for that user, not
  just the one requested. A design that says a large value is "read once per process" should
  instead say "reloaded whenever any setting for that user is next written", which is a much
  more frequent event, even though the actual cost (one in-memory Map, a few hundred KB) is
  negligible for a single-user app.
- Plan 2 (assistant triage) shipped as: 819e39e/3392ab7 (plan 1, tool calling), then
  aa9fe5a, 239359e, 6b7e6e5, df1173b, ec2e776, d3e2f68 (plan 2 tasks 1 to 4 plus two same-day
  fixes). Plan 2's docs task landed folded into df1173b's commit rather than as its own
  commit, worth checking for when judging whether a plan's own commit boundaries were
  actually followed.
