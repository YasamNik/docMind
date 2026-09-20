---
name: lesson-runturn-fully-buffered
description: assistant.usecases.ts runTurn and every capability handler buffer the whole reply before returning; there is no streaming anywhere in the assistant path today
metadata:
  type: project
---

Verified 2026-09-20 while ruling on plan 5 (app chat page onto runTurn).

`assistant.usecases.ts` `runTurn` returns `Promise<TurnResult>`, not a generator. Its
tool-choosing loop (`for await (const part of stream)`) only accumulates `accumulatedText`
and `chosenCall`; nothing is yielded until the loop ends. Both answering capability
handlers in `assistant.registry.ts` (`answerFromDocuments` line 67, `searchWeb` line 114)
call a local `drain(stream)` helper (line 24-28) that consumes the RAG stream fully into
one string before returning `ToolResult`. `answerWithoutTools` (the no-tools fallback)
goes through the same handler and the same `drain`. So every path out of `runTurn`,
`runCommand`, and `answerProposal`, tool call or not, model-supports-tools or not, is
already fully buffered by design. There is no partial-output seam to hook a token stream
onto without changing `drain`, `ToolResult`, and `runTurn`'s own return type, which
Telegram also depends on (`telegram.usecases.ts` `handleAssistantTurn` reads
`TurnResult.reply` as a whole string for one `client.sendMessage` call).

**Why this matters:** any future plan that proposes "stream the reply when runTurn
doesn't call a tool" is proposing a real structural change (async generator or callback
threaded through `drain`/`runHandler`/`runTurn`), not a small tweak, and doing it for the
app surface only would fork the shared runTurn path CLAUDE.md's session workflow and the
2026-09-19 spec both want kept singular ("the same path Telegram already uses"). It also
cannot be true token-by-token streaming even in principle for the tool-choosing call: a
tool call can arrive after some preamble text in the same stream, and `runTurn`'s own
comment (around line 438) says text before a winning tool call is dropped, never shown,
so speculative live streaming would sometimes show text that then has to be retracted.

**How to apply:** when a plan wants token streaming on any surface that goes through
`runTurn`, check whether it proposes changing `drain`/`ToolResult`/`runTurn`'s return
shape. If it does, that is a shared-path refactor and needs the same scrutiny as any other
change to code both surfaces depend on. If it doesn't, the plan is probably promising
streaming it cannot deliver.
