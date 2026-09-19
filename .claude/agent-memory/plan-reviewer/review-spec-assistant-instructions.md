---
name: review-spec-assistant-instructions
description: Assistant instructions/tool-calling spec review (2026-09-19), feat/email-intake branch - sent back, tool calling does not exist in the AI layer, confirmation state machine has no storage design
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md` on
2026-09-19, branch `feat/email-intake`, against the already-shipped assistant (commits
dc42934, 774a18d, 192da06). Verdict: needs redesign on the tool-calling mechanism before
it is a plan, see [[lesson-tool-calling-and-pending-confirmation]] for the reusable
technical lessons.

**Headline gap:** the spec's entire design rests on "triage is tool choice, not a
separate pass," but grepping `apps/server/src/modules/ai/adapters/*.ts` and
`ai.types.ts` shows neither the OpenAI-compatible nor the Anthropic adapter passes a
`tools` param or parses a tool-call response today; `streamChat` only ever yields plain
text deltas. This is the single biggest unscoped piece of work in the spec and it calls
it a solved precondition.

**Second gap:** the confirmation flow (propose a write, wait for yes/no on the next
turn) has no storage answer. `chat_sessions` is many-per-user so a flat per-user settings
key (the pattern Telegram already uses for its one-conversation-at-a-time state) does
not fit the app surface without session-scoping the key, which is a departure from how
`settings.usecases.ts` is used everywhere else in the codebase. Telegram's side needs
`callback_query` handling the poll loop does not have, which the spec does correctly
flag as new work, but the underlying "where do proposed tool args live between turns"
question is not addressed for either surface.

**Third gap:** `chat.usecases.ts`'s `MAX_CONTEXT_CHARS = 12000` caps only the retrieved
RAG chunk block (`buildContextBlock` in `chat.models.ts`), not the system prompt.
Appending an unbounded user instructions document to the system prompt on every call has
no shared budget with retrieval; the editor's size warning is a UI nudge, not an
enforced cap, so a long instructions document silently has no effect on retrieval
(nothing trims it) but does increase cost and risks crowding the model's attention.

**Fourth, lower severity:** unifying `CHAT_SYSTEM_PROMPT` and
`TELEGRAM_ASSISTANT_SYSTEM_PROMPT` is an explicit, stated decision (spec section 5), not
a hidden one, and `chat.models.test.ts` asserts against the `CHAT_SYSTEM_PROMPT` export
by identity rather than content, so it survives mechanically. The real product question
is whether the app's primary chat surface should stop being RAG-refuse-by-default and
gain save-note/web-search/new-thread tool access; worth a one-line confirmation from the
user even though the spec already states the intent.

**Scope:** recommended splitting into at least (1) AI-layer tool calling per adapter
plus a `supportsTools`-style capability flag, gated on a model that actually supports
it, (2) the confirmation state machine and storage design, gated on user sign-off if it
turns out to need a schema change, (3) the instructions document CRUD, versioning, and
system-prompt budget interaction, (4) the capability registry and individual tool
wiring (mostly already exist as usecases), (5) prompt unification and the client UI
work for in-stream confirmation buttons. The spec bundles these as one design; the plan
should not.

See [[review-spec-telegram-intake]] for the related, still-relevant Telegram poller and
settings-store lessons this review reused directly.
