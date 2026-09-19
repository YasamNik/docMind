---
name: lesson-tool-calling-and-pending-confirmation
description: How to check a spec that assumes native LLM tool calling exists, or that proposes a write-then-confirm turn across two model calls
metadata:
  type: feedback
---

Found first in the assistant instructions/tool-calling spec review (2026-09-19,
`docs/superpowers/specs/2026-09-19-assistant-instructions-design.md`).

**1. "Tools exist today" often means the underlying usecases exist, not that the AI
layer can call them.** Read `apps/server/src/modules/ai/ai.types.ts`'s `AiAdapter` type
and both `apps/server/src/modules/ai/adapters/*.adapter.ts` before accepting a spec that
gives the model a set of tools to choose from. As of this review neither adapter's
`streamChat`/`generateStructured` accepts a `tools` param or parses `tool_calls` /
`tool_use` content blocks; `AiProviderCapabilities` has no `supportsTools` flag the way
`supportsStructured` exists for structured outputs. A spec that lists "tools, all of
which exist today" is describing the handlers, not the tool-calling wire protocol. That
protocol differs by adapter (OpenAI-style `tool_calls` array vs Anthropic's `tool_use`
content blocks) and interacts with streaming: OpenAI-compatible tool-call arguments
arrive as streamed deltas that must be reassembled before they are valid JSON, so a
naive "stream tokens, look for tool calls" design does not work as written. Treat this
as a Blocker-level gap, not a risk footnote, if the spec does not name the adapter
interface change, the per-adapter parsing difference, and whether the first
tool-choosing call is streamed or not.

**2. A propose-then-confirm write across two turns needs a named pending-state store,
and the answer is not obviously "reuse settings."** `settings.usecases.ts` is a flat
per-user key/value store (see [[lesson-background-loop-and-notification-gaps]] for its
hook surface), and Telegram already stores single-value per-user session state there
(`telegram.chatSessionId`, `telegram.lastReportedAt`) because Telegram has exactly one
active conversation per user. The in-app chat does not: `chat_sessions` is one-to-many
per user, so a flat `chat.pendingConfirmation` settings key collides across two open
chat tabs/sessions. If a spec's confirmation ("propose a tool call, wait for yes/no
next turn") does not say where the proposed tool name and arguments are stored between
turns, on both surfaces, that is a gap worth raising before implementation, because the
options are: a new column/table (triggers `.claude/rules/schema-changes.md`, needs
explicit user sign-off before code), a session-keyed settings value (a real departure
from the settings module's static-key registry pattern), or an in-memory map (breaks on
restart, wrong for a database-backed app). Also check whether the SSE event vocabulary
(`ChatStreamEvent` in `chat.usecases.ts`) has room for a "tool call pending, awaiting
confirmation" event distinct from `token`/`done`/`error`; if not, the confirmation UI
needs a new server-client contract, not just "a pair of buttons," and Telegram's
equivalent (`callback_query`) is new transport work the poll loop does not have yet.

**How to apply:** whenever a spec turns a chat/assistant surface into a tool-calling
agent, or adds any multi-turn confirm-before-write flow, check (a) the `AiAdapter`
interface and both adapter files for existing tool-call support before believing the
spec's "already exists" framing, and (b) trace exactly where pending-turn state would
live given the existing chat/telegram data model, since "propose now, act on the answer
next turn" always needs a place to keep the proposal that survives to the next request.
