---
name: lesson-background-loop-and-notification-gaps
description: How to check a spec that adds a persistent background loop reactive to settings, or a "notify when a document's pipeline finishes" feature
metadata:
  type: feedback
---

Two infrastructure gaps keep recurring when a spec proposes a new intake channel or a
completion notification, found first in the Telegram intake spec review (2026-09-18).

**1. There is no post-write settings hook.** `settings.usecases.ts`'s only extension
point is `beforeSet` (pre-write validation, wired once in `server.ts` for AI model slot
checks). There is no `afterSet`, no event emitter, nothing that tells another in-process
service "this key was just written." Grepping the whole server for `EventEmitter`,
`emitter`, `.emit(`, `setInterval` outside `jobs.runner.ts` returns nothing. If a spec
proposes a long-lived background loop (a poller, a persistent connection) that must
start or stop in reaction to a settings value someone edits at runtime through the
settings API, the spec must say how. The cheap, precedented answer: have the loop itself
re-read the setting each cycle (mirroring `jobs.runner.ts`'s own poll-then-act shape)
rather than inventing a new push mechanism. Flag as Major if the spec is silent on this.

**2. Job fan-out is not a chain, and there is no job-completion hook.** After
extraction, `extraction.usecases.ts` enqueues `rules`, `embedding`, and `summarize` jobs
independently in one transaction (see the three `jobs.enqueue` calls after the
`documents.update` in `extractDocument`), not sequentially. `jobs.runner.ts` is a flat
poll loop over `handlers: Record<type, JobHandler>` built once in `server.ts`; `process()`
has no "after this job type finishes, call X" extension point. Any spec that wants to
notify or act once "the document is fully processed" needs a real design: usually
waiting for two or more status columns (e.g. `ruleStatus` AND `summaryStatus`, not
`embeddingStatus` unless the feature actually needs embeddings) to reach a terminal
state (`done` or `failed`), which nothing today observes. A spec that describes this as
"a notification at the end of the existing chain" without naming the columns it waits on
and how it watches them is glossing over new cross-module orchestration. The
lowest-risk answer is a poll owned by the feature itself (not a hook added to
`jobs.runner.ts` or the `rules`/`summary` modules), checking the documents it cares about
each cycle.

**3. DNS-resolve-then-check is not enough to stop SSRF/rebinding.** If a spec's
outbound-fetch guard resolves a hostname, validates the IP is public, and then makes the
actual request by hostname again (`fetch(url)`, `https.request(url)`), the HTTP client
re-resolves DNS at connect time and can get a different, attacker-controlled address
(the classic `attacker.com` -> public IP at check time -> `127.0.0.1` at connect time
rebind). The concrete fix to demand: a custom `lookup` function passed to
`http.request`/`https.request` (or an undici `Agent` with `connect.lookup` when using
`fetch`), so resolution and validation happen exactly once and the connection is forced
to the address that was checked. A spec that says "checked after DNS resolution" without
naming this mechanism will likely get an implementation with a live TOCTOU hole, even
though the author clearly knew to check the resolved address rather than the hostname.

**How to apply**: whenever a spec adds (a) a new intake channel with its own background
process, or (b) a "fires when processing completes" notification, or (c) fetches a
user-supplied URL server-side, check these three points explicitly against the current
code (grep for `EventEmitter`/`setInterval`, read `extraction.usecases.ts`'s enqueue
block, read `settings.usecases.ts`'s hook surface) before accepting the spec's framing
that existing infrastructure already covers it.
