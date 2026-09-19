---
name: review-spec-telegram-intake
description: Telegram intake (feature 15) spec review, 2026-09-18 - "no new table" breaks at the second-reply notifier, job fan-out is not a chain, poller settings-reactivity undesigned, DNS TOCTOU underspecified
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-18-telegram-intake-design.md` on 2026-09-18,
branch `feat/telegram-intake`. Sent back, not ready for a plan. See
[[lesson-background-loop-and-notification-gaps]] for the reusable technical lessons;
this entry is the project-specific record.

**The headline claim ("everything becomes a document, no new table") holds for intake
itself but breaks at the completion notifier.** Verified `documentsService.upload()`
(`apps/server/src/modules/documents/documents.usecases.ts`) takes a plain
`{ name, mimeType, body: Readable }`, so a text note or a fetched link works exactly like
a browser upload with no special-casing, and `textExtractor` already exists for
`text/plain`. That part of the spec is solid. But section 7's second reply needs the
document to record it came from Telegram, so the notifier fires only for bot-created
documents. There is no existing column or generic JSON field on `documents` for this;
it is a real new column (or table), which is a database change requiring the user's
explicit sign-off per `.claude/rules/schema-changes.md` and the autonomy rule, not
something the spec should gloss over. Also worth noting: pairing supports exactly one
Telegram user/chat at a time (`telegram.pairedUserId` is a single value), so "and from
which chat" in the spec is over-specified. A boolean/enum source flag is enough; no
per-document chat id is needed.

**The "job chain" framing is factually wrong, which matters because the fix depends on
knowing the real shape.** `extraction.usecases.ts` enqueues `rules`, `embedding`, and
`summarize` as three independent jobs in one transaction after extraction succeeds, not
a sequential chain. `jobs.runner.ts` has no completion hook of any kind. A reply
containing title, category, and tags needs both `summaryStatus` and `ruleStatus` (not
`embeddingStatus`) to reach a terminal state, and nothing today watches that. Recommended
fix in review: a poll owned by the telegram module itself over documents it marked as
telegram-origin, not a hook added to `jobs.runner.ts` or the `rules`/`summary` modules.

**Poller lifecycle vs. live settings writes is undesigned.** Confirmed by grep that no
event/pubsub exists in the server for "a setting was just written" (`settings.usecases.ts`
only has `beforeSet`, a pre-write validation hook, used today for AI model slot checks).
The only long-lived background loop in the codebase is `jobs.runner.ts`, which has a
fixed handler set built once at server boot. The spec says the poller "starts... when a
bot token is configured, and stops when cleared" but never says how it learns about a
runtime settings change. Recommended: the poller re-checks the current token setting
each cycle, mirroring `jobs.runner.ts`'s own poll shape, rather than a new push
mechanism.

**DNS TOCTOU guard (section 6) needs a named mechanism, not just "checked after DNS
resolution."** If implemented as resolve-then-validate-then-`fetch(url)`-by-hostname,
the HTTP client re-resolves DNS at connect time and the rebinding case the guard exists
to stop (`localhost.attacker.com`) slips back in. The fix: a custom `lookup` function on
`http.request`/`https.request` (or an undici `Agent` with `connect.lookup` for `fetch`)
so resolution and validation happen exactly once and the connection is forced to the
checked address. Also flagged: no HTML readability library (jsdom, cheerio, linkedom,
@mozilla/readability) exists in `apps/server/package.json` today, so "the page's readable
text" is an undecided new dependency, not a one-line detail.

**Scope.** Recommended splitting into at least: (1) transport, pairing, settings UI,
files and text intake with the first reply, which is close to plan-ready once the
settings-reactivity question is answered; (2) link intake, isolated because it is the
one security-sensitive part and needs a library decision; (3) the second reply /
completion notifier, gated on the user approving the schema change first.

**Minor pattern worth reusing:** settings marked `internal: true` are excluded from the
auto-generated settings form (`listResolved()` filters them, `settings.usecases.ts`) and
can only be written via `setInternal()`, not the API's `set()`. Any settings key that is
supposed to be an action's side effect (a generated pairing code, a paired-user id set
only by the pairing flow) rather than a user-typed value should be marked `internal` and
given a bespoke route, or it will render as a raw editable text field in the generic
settings UI.

See [[review-spec-storage-drivers]] and friends for the running list of spec review
sessions on this project.
