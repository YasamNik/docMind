---
name: review-ruling-assistant-plan5
description: The three rulings given for assistant plan 5 (app chat page onto runTurn) before the plan was written, so the eventual plan/code review can check it followed them
metadata:
  type: project
---

Ruled 2026-09-20, before plan 5 was drafted, at the requester's request to skip straight to
implementable decisions (CLAUDE.md's "DO NOT OVERENGINEER" section, added 2026-09-19, was
the explicit lens). No menus were presented back; these are the decisions to check the
actual plan/commits against.

1. **No token streaming on the app chat page once it moves to runTurn.** `runTurn` and
   every capability handler already buffer the whole reply before returning (see
   [[lesson-runturn-fully-buffered]]). Building partial streaming would mean changing
   `drain`/`ToolResult`/`runTurn`'s return shape, shared with Telegram, or forking the
   path for app only, both of which the "same path Telegram already uses" instruction and
   the overengineering doctrine rule out. The app page shows the existing three-dot
   "thinking" indicator (`ChatPage.tsx` `MessageBubble`'s `isEmpty` branch) while the
   request is in flight, then paints the full reply at once, the same experience Telegram
   already gets. Ruled out: streaming only the no-tool path (can't know a tool call isn't
   coming until the model's turn stream ends, and speculative streaming would sometimes
   show text that a later tool call forces retraction of) and keeping two code paths.

2. **`answeringPromptFor` is deleted.** Since the app answering path now uses the
   conversational, non-refusing prompt too, the surface branch it exists for disappears.
   Its two call sites in `assistant.registry.ts` (`answerFromDocuments`, `searchWeb`) call
   the merged prompt directly. `chat.models.ts`'s `CHAT_SYSTEM_PROMPT` constant is NOT
   deleted: `chat.usecases.test.ts` and `chat.models.test.ts` use it as a generic sample
   prompt for the lower-level RAG plumbing, unrelated to which prompt the assistant module
   picks for a surface. Only the assistant module's own use of it as the app's answering
   prompt goes away. Three existing tests assert the old surface split and must be
   rewritten, not left alongside new behavior: `assistant.models.test.ts` line 263
   (`answeringPromptFor("app")` equals `CHAT_SYSTEM_PROMPT`), `assistant.registry.test.ts`
   lines 272 and 321 (`systemPrompt` for the app surface contains `CHAT_SYSTEM_PROMPT`).
   The merged prompt text must drop `CHAT_SYSTEM_PROMPT`'s "this page" wording (the
   storage-driver caveat, `chat.models.ts` line ~30) since Telegram has no page to imply
   a document opens from; write one sentence true for both surfaces instead of
   concatenating the two prompts as-is.

3. **Document-scoped session tool restriction is not built now.** No client creates a
   `documentScope` session today (`chatApi.createSession` accepts it, nothing ever passes
   it; verified by grep). Per the overengineering doctrine's own test, nothing breaks
   today if this is left out. Left as a written-down gap instead: when a client can create
   one, the guard belongs inside `runHandler` (`assistant.usecases.ts`, the single point
   both `runTurn` and `runCommand` funnel through), keyed off a per-capability record flag
   (matching the existing `writes`/`destructive`/`recordsTurn` pattern), not off trimming
   the tool list offered to the model. Trimming the offered list alone would not stop a
   direct `runCommand` call (a typed command bypasses triage entirely), the same
   two-entry-point gap as [[lesson-runcommand-validation-and-registry-naming]]. Retrieval
   scoping itself already works independent of this: `chat.usecases.ts`
   `answerFromDocuments` (line 166-168) filters search results by the session's own
   `documentScope` column regardless of which capability called it.
