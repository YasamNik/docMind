---
name: telegram-retry-idempotency
description: Ruling on telegram.usecases.ts cursor/redelivery duplication of assistant turns (2026-09-19); reuse if a fix PR or follow-up plan touches pollUpdatesOnce retries
metadata:
  type: project
---

Ruling delivered 2026-09-19 on `apps/server/src/modules/telegram/telegram.usecases.ts`
(`pollUpdatesOnce`, `handleUpdate`, `handleAssistantTurn`).

The real bug is narrower than "cursor written after handling." `handleAssistantTurn`
already catches every error from `startTurn()` (the model call path) and replies with
`assistantTroubleReply()` instead of throwing. The ONE place it still throws is the
final unguarded delivery loop, `for (const part of splitForTelegram(reply)) { await
client.sendMessage(...) }` (no per-send retry, no try/catch). A failure there escapes
to `pollUpdatesOnce`'s outer `updateRetryAttempts` loop, which retries the entire
`handleUpdate`, which calls `startTurn()` again: a second `chatService.appendUserMessage`
and a second paid model call for a turn that had already produced a `result`. That is
the dominant, realistic trigger, not the external Telegram-redelivery/crash case.

Ruling: fix the delivery loop only, wrap `client.sendMessage` in a short bounded retry
(reuse the `defaultUpdateRetryDelayMs` style already in this file) and swallow-and-log
on exhaustion rather than rethrow. No schema change, no persisted dedup ring, no
change to cursor-write timing.

Do not move `telegram.lastUpdateId` to advance before handling. The retry-exhausted
path already advances the cursor unconditionally today (`telegram.usecases.ts` around
line 549 runs regardless of `handled`), so cursor-before only changes behavior for a
mid-handling process crash, an already-tiny window that shrinks further once the send
loop is fixed. Moving it earlier turns that same crash into a silent, permanent loss of
a file/note/link message (no hash-dedup safety net possible if the upload never ran),
which is a worse failure mode for a document-intake tool than an occasional duplicate
LLM reply. Keep cursor-after.

Do not add a recently-handled-update-id ring in settings either, even though it would
need no migration (settings are key/value). It only guards the same near-zero-probability
crash window and costs a settings read/write, ring-size and eviction design, and code,
for a benefit of avoiding one duplicate model call that will likely never occur in this
bot's real lifetime. Document the residual risk instead of building for it.

General lesson for this module: a blanket "retry the whole handler" loop is only safe
when every step inside is idempotent (file/link intake is, via content-hash dedup in
`documentsService.upload()`). The moment a handler mixes idempotent steps with one
non-idempotent, costly step (an LLM call plus an unconditional chat-history append),
retries must be pushed down to the boundary that actually needs them (the network send),
not applied at the top of the handler. Check this same pattern if a future plan adds
another outer-retried handler that also does a model call or other paid, stateful step.
