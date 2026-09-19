# The assistant's confirmation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A write the assistant chose for itself never happens until the user says yes.
The offer is held in one nullable column, answered by a button or by a bare yes, and the
guard that makes it unskippable is a flag on the capability record, not a line in a prompt.

**Architecture:** `chat_sessions.pending_tool_call` holds one proposal per session as JSON:
the tool, its parsed arguments, the exact sentence the user was shown, and the id of the
assistant message carrying it. The chat module owns the column and treats the value as an
opaque string. The assistant module owns its meaning: it decides what needs confirming
(`writes || destructive`), writes the proposal instead of running the handler, and later
claims the proposal with a conditional update before running anything. Telegram attaches an
inline keyboard and gains a `callback_query` branch in the poll loop. The app gets a stream
event variant and two routes, and renders them in plan 5.

**Tech Stack:** Drizzle with libsql (one additive column, one conditional update returning
`rowsAffected`), the assistant module's registry and turn runner, the Telegram Bot API's
`callback_query` and `answerCallbackQuery`, valibot, vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md`, sections 4,
5 and 8. This is plan 3 of five, written after plans 2 and 4 shipped, so it is built against
the code rather than against the spec's description of it.

## What earlier plans already gave us, so this plan does not re-argue it

- Plan 2 (239359e, 6b7e6e5, df1173b, ec2e776, d3e2f68) put every tool in
  `assistant.registry.ts` as a record with `writes`, `destructive` and `recordsTurn` flags,
  and `runTurn` and `runCommand` in `assistant.usecases.ts` as the one path both surfaces
  use. Nothing in the runner branches on a tool's name and nothing here starts.
- A tool handler writes the user-facing reply itself. A tool result is never appended to
  the turn's own `messages` array and handed back to the model. A proposal follows the same
  rule: its sentence is built by code, from the record, and is the whole reply.
- Text the model wrote before a tool call is dropped (plan 2, Decision 5). That is load
  bearing here: a model that writes "Saved that for you" and then calls `saveNote` shows the
  user only the proposal sentence, never its own claim.
- Plan 4 (891d506, 3fa434f, be39b5e) shipped the instructions document, `ToolContext.instructions`,
  and the precedence paragraph that already tells the model that what has to be confirmed is
  decided in DocMind's code. Plan 4's Task 5 (`proposeInstruction`) and Task 6 (docs) were
  deliberately not landed. Both are in this plan, as Tasks 5 and 6.
- `runHandler` turns an AppError into a plain reply and marks it `failed`, so a tool that
  cannot run never throws a turn away. Every new failure path here uses that same shape.
- Telegram's cheap-message guard already declines to short circuit when the assistant's last
  message ends in a question mark (`isAnsweringAQuestion`, `telegram.models.ts`). Decision 6
  leans on it on purpose rather than adding a second mechanism.

## Global Constraints

- **One column, and its migration lands in the same task.** `chat_sessions.pending_tool_call`,
  nullable text, approved by the user on 2026-09-19 for exactly this. Nothing else in this
  plan may touch a `*.tables.ts` file. If a step appears to need a second column, a second
  table, or an index, stop and put it to the user on its own, per `.claude/rules/schema-changes.md`.
- **The stored value is parsed with valibot every time it is read.** It is written by one
  version of the code and read back by another, after a restart, a deploy, or a registry
  change. It is treated as untrusted input, and so are the arguments inside it, which are
  re-parsed against the capability's own schema before the handler runs.
- **The guard is code.** `requiresConfirmation(capability)` reads the record's own flags.
  No prompt sentence, no instructions document, and no model output decides whether a write
  waits. The prompt does tell the model what confirmation means, because a model that does
  not know will claim to have saved something, but nothing in the prompt is load bearing.
- **A slash command is its own confirmation, except for a delete.** `/note` still writes
  immediately. `destructive` confirms on every path, including a typed command.
- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Module file roles: pure logic in `*.models.ts`, orchestration in `*.usecases.ts`, Drizzle
  only in a repository, Hono only in routes, valibot at every boundary. The assistant module
  must not gain a Drizzle import: it reaches the column through the chat service.
- No test may make a network call, need a bot token, or need a model key.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

## Decisions

**1. `allowWritingTools` is deleted, in the same commit that lands the state machine.**
Plan 4's review warned that flipping the flag without the machinery would silently break
"every write confirms". The way to make that impossible is not to sequence the flip
carefully, it is to make the flag stop existing at the moment the machine exists. Task 2
does both in one commit: `createAssistantService` loses the option, the
`capabilities.filter((c) => !c.writes || allowWritingTools)` line becomes
`Object.values(capabilities)`, `buildAssistantPrompt` loses `writesWithheld`, and the
paragraph telling the user to send `/note` is replaced by the paragraph telling the model
that a write waits for a yes.

Leaving the flag at a default of `true` was the alternative. Rejected: a flag nothing sets
is configuration that only rots, its `false` branch would never run in production again, and
its one remaining effect would be to strip the confirmation feature out from under the
invariant this plan exists to establish. `git revert` is the kill switch.

What proves the flip is safe is not the flag's absence but this test, in Task 2, written
against a capability built for the test rather than against `saveNote`:

```ts
it("runs no handler that writes or deletes until a proposal has been claimed", async () => {
  // A test registry with two extra records, one writes, one destructive, each with a
  // handler that sets a spy flag. For each, drive the fake adapter to call it from
  // runTurn. Assert: the handler never ran, the session has a pending proposal, the
  // reply is the record's own confirm sentence, and toolUsed is null.
  // Data driven over the registry, so a capability added later is covered by this test
  // on the day it is added rather than by someone remembering to write a new one.
});
```

And its pair, for the real thing: "the model choosing saveNote writes no document, and the
document list is unchanged until a yes arrives."

**2. A message that is not an answer runs as an ordinary turn, and leaves the proposal
standing.** This is the decision the feel of the whole feature rests on, so here is the
exact rule:

A pending proposal is treated as answerable by plain text only while it is still the last
thing the assistant said. Concretely, `pending.messageId` equals the id of the session's
most recent assistant message. In that state, and only in that state,
`readConfirmationAnswer(text)` runs:

| The user sends | What happens |
|----------------|--------------|
| a message that is only an affirmation ("yes", "yep", "ok", "go ahead") | the tool runs, with no model call at all |
| a message that is only a refusal ("no", "nope", "cancel", "never mind") | nothing is written, the proposal is discarded |
| anything else, including "yes, and what is my excess?" | an ordinary turn. The proposal stays pending and its button still works |

Once the conversation has moved on, a bare "yes" is an ordinary turn too, because it is far
more likely to be answering the assistant's latest question than a proposal three messages
back. The button is then the only way to answer, which is the whole reason the button
exists.

Three properties fall out of this and each one is tested:

- **The user is never stuck.** Every message is answered. There is no state in which the
  assistant will only accept yes or no.
- **An ambiguous message never counts as a yes.** Only a message that consists solely of an
  affirmation is read as one, so a sentence that happens to contain the word cannot write
  anything. A missed yes costs one button press; a wrong yes writes something nobody asked
  for, and the two are not symmetric.
- **A yes can never fire at the wrong target.** A proposal and a later `askUser` question
  cannot both be answered by the same bare "yes", because the proposal stops accepting text
  the moment it stops being the last assistant message.

The alternatives were: making any next message discard the proposal, which loses the "yes,
and..." case with no way back, since the button would be stale too; and asking the model to
classify the reply, which spends a call and adds a judgement where a word list is exact.

**3. At most one proposal per session, and a second one replaces the first.** The column
holds one value, so this is true by construction rather than by a rule anyone has to
enforce. The replaced proposal's id is no longer the stored one, so its button is stale and
says so. That is the spec's "a second proposal while one is pending does not confuse them",
answered by the data shape.

**4. Answering is a claim, not a check then a write.** `clearPendingToolCallIf` is one
conditional update: set the column to null where the session is the user's and the column
still equals the exact string this caller read. `rowsAffected` says whether this caller won.
Only the winner runs the handler. Two taps on Yes, or a button press and a typed yes racing,
produce one write and one "that one is not waiting any more". There are no nested
transactions to reach for on a single libsql connection, and this needs none: it is one
statement.

The claim happens before the handler runs, not after. If the handler then fails, the
proposal is gone and nothing was written, and the reply says what went wrong. The other
order risks running the handler twice, and a double write is worse than a repeated offer.

This is also what makes Telegram's update-level retry safe: `pollUpdatesOnce` retries a
failed update up to three times, and the second attempt at an already-claimed proposal is a
no-op with a plain reply rather than a second note.

The one write worth protecting is the yes path's handler call, so it runs immediately after
the claim succeeds, before anything is appended to the conversation. Appending the user's own
turn calls `chatService.appendUserMessage`, which resolves the session itself and throws
`chat.session_not_found` if it no longer does; running the handler first means that if this
append then fails, the note, or whatever the tool wrote, already exists, and only the
conversation's own record of asking and answering is missing. `runHandler` already lets
`chat.session_not_found` escape rather than swallowing it into a reply, and `answerProposal`
does the same, for the same reason: it is not a sentence a user can act on, and the caller
needs to see it rather than a generic trouble reply. It does not, though, retry on a fresh
session the way `handleAssistantTurn` retries an ordinary turn: a fresh session has no pending
proposal to answer, so retrying there would not recover this call, only start an unrelated
one. The surface shows the trouble reply instead, and whatever the handler already did stands.

**5. A restart loses nothing because nothing is in memory.** The proposal is a row. The test
that proves it constructs a second, entirely fresh assistant service over the same database
and answers a proposal made by the first one. There is no in-process map, no timer and no
cache to invalidate, and the test fails loudly the day someone adds one.

There is no expiry. A proposal waits until it is answered or replaced. An expiry would need
a clock in the state machine and would introduce a fourth outcome nobody asked for, and the
bound on damage is already there: at most one proposal per session, the exact sentence is
shown again in the confirmation, and the reply states what happened. When a `destructive`
capability eventually exists, whoever adds it should re-read this paragraph and decide
whether a delete proposed a week ago should still be pressable. Today nothing destructive
exists to expire.

**6. The confirm sentence ends with a question mark, and that is load bearing.** Telegram's
cheap-message guard reads exactly that (`isAnsweringAQuestion`), which is how a bare "ok"
answering a proposal reaches the assistant instead of being short circuited into a thumbs
up. Plan 2 Decision 7 already named this synergy for `askUser`; this plan reuses it rather
than teaching the telegram module about proposals. Two tests hold it: a registry data test
that every confirm sentence ends in "?", and a telegram test that a bare yes after a
proposal is not answered with an emoji.

It also gives the lingering-proposal case the right cost profile for free. Once the
conversation moves on, the assistant's last message is an ordinary reply, so "thanks" short
circuits again as it always did, even though a proposal is still pending.

The worst case if this ever breaks is one wasted thumbs-up reply, never an unintended write,
because the write is guarded by the claim and not by the guard.

**7. The chat module stores the value, the assistant module understands it.** The column is
on a chat table, so Drizzle access lives in `chat.repository.ts` and the chat service exposes
set, read and conditional clear over a plain string. It never parses that string. The
assistant owns `pendingToolCallSchema`, builds the sentence, and decides what the arguments
mean. The dependency stays assistant to chat, which is the direction it already runs.

The one thing the chat module does own is the shape the client is shown, `PendingProposal`
in `chat.types.ts`, because `ChatStreamEvent` is the chat module's protocol and cannot
reference an assistant type without inverting that dependency. It carries no arguments: the
sentence is the rendering, and the arguments have no business leaving the server.

`presentSession` strips `pendingToolCall` from everything the chat API returns. A raw
internal JSON blob on `GET /api/chat/sessions` would be a second, unparsed door onto the
same state, and the client already has a typed one.

**8. The stream event ships in this plan, the emitter arrives in plan 5, and that is said
out loud.** `ChatStreamEvent` gains `{ event: "proposal"; data: PendingProposal }` here,
because it is a server to client protocol change and the protocol is this plan's business.
Nothing emits it yet: the app's chat page still runs `chat.sendMessage`, which never calls a
tool, and moving it onto `runTurn` is plan 5's first task.

What does ship live for the app is the pair of routes in Task 4, `GET` the waiting proposal
and `POST` the answer, both tested end to end over HTTP. They are what a page reload needs
anyway, they use the same `PendingProposal` type the event will carry, and they mean plan 5
is a rendering task rather than a protocol task. `ChatPage.tsx` dispatches SSE events by
name through an if chain and ignores anything it does not know, so adding the variant cannot
break today's client.

**9. `proposeInstruction` lands here, as the last code task.** Plan 4 deferred it to "plan 3
or straight after it" because it is a writing tool with no slash command, so landing it
before confirmation would have shipped a handler nothing could safely reach. Here is why it
belongs in this plan and not in plan 5:

- It is the second writing capability. One is not enough to prove the machine is data
  driven: with only `saveNote`, a confirmation flow shaped around notes passes every test.
  A second record with a different argument and a different sentence is what proves the
  proposal builder reads the registry.
- Spec section 4 says the offer shows the exact line before it is written. That sentence is
  only true once a proposal holds the parsed arguments, which is this plan.
- Plan 5 is prompt unification and client rendering. A server-side registry record has no
  home there.
- It is last and independently committable, so if the state machine takes longer than
  expected it can be dropped without touching Tasks 1 to 4.

The decline half of section 4 still needs no storage: a declined offer is an assistant turn
in the history the triage call already reads, plus one line in the confirmation prompt
section telling the model not to offer the same thing twice in a conversation.

**10. The yes and no word lists are English only.** The user writes to the bot in English
and Turkish. A Turkish "evet" is read as unrelated, which means the message is answered
normally and the proposal stays pending for the button, so the failure mode is a button
press rather than a wrong write or a dead end. The button is language independent and is the
real answer path. Adding words is a one line change to a list in `assistant.models.ts` if the
user asks for it, and is worth mentioning to them when this lands.

The sentences carrying the question are the same story in the other direction.
`capability.confirm(args)` and the stale, declined and unavailable replies are built by code,
in English, with no instructions document in the loop, so a user who has told the model to
answer only in Turkish still gets an English question in the middle of a Turkish conversation
the moment a write is proposed. Nothing in this plan translates them: the guard and its
sentences are one thing, `requiresConfirmation` reading a flag, and it stays that simple on
purpose. This is a known limitation to mention when the feature lands, not a redesign to
attempt here.

**11. Telegram's callback is answered after the work, not before.** `answerCallbackQuery`
stops the spinner on the button, and Telegram allows a good few seconds for it. Every
capability that can be confirmed is a local write with no model call in it, so answering
afterwards costs nothing and lets the toast carry the outcome, including "that one is no
longer waiting". The call is wrapped so a late or rejected answer is logged and never fails
the update, and removing the keyboard afterwards is best effort for the same reason: the
stale-id guard, not the missing button, is what makes a second press harmless.

## The stored shape, in full

`chat_sessions.pending_tool_call` holds this, JSON encoded, or SQL NULL:

```ts
// assistant.schemas.ts
export const pendingToolCallSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),         // prop_<hex>, short enough for callback_data
  tool: v.pipe(v.string(), v.minLength(1)),       // the capability's own name
  args: v.unknown(),                              // re-parsed against the record's schema on the yes path
  text: v.pipe(v.string(), v.minLength(1)),       // the exact sentence the user was shown
  messageId: v.pipe(v.string(), v.minLength(1)),  // the assistant turn carrying it, see Decision 2
  proposedAt: v.pipe(v.string(), v.minLength(1)), // ISO 8601 UTC, for the view and for a log line
});
```

`args` is `v.unknown()` here on purpose. The envelope's job is to be readable; the
arguments' job is to be valid for one specific tool, and only that tool's own schema knows
what valid means. Parsing them twice with two different ideas of the shape is how they drift.

Three read failures, all of which degrade rather than throw:

| What happened | What the user gets |
|---------------|--------------------|
| the value does not parse as the envelope | the column is cleared, the turn runs normally, one log line with the session id and never the value |
| `tool` names a capability that no longer exists | the column is cleared, the reply says it is not something the assistant can do any more |
| `args` no longer parse against that capability's schema | the same, and nothing is written |

This table describes `runTurn`'s own read, which already has a turn to run and a row to touch
either way. `getPendingProposal` reads the same column for the `GET` route and for
`answerProposal`'s own first step, and neither of those has a turn to fall through to, so both
degrade without writing anything: a value that fails to parse, names a capability that is
gone, or carries arguments that no longer fit that capability's schema reads as null for
`getPendingProposal`, or as `{ status: "stale", ... }` for `answerProposal`, in both cases
leaving the column exactly as read. A `GET` must not turn a stale value into a 500, and it
must not turn into a write either, since looking is not answering. Clearing a value neither of
these two calls wrote is left to `runTurn`, which does it the next time an ordinary turn runs,
or to the next successful `setPendingToolCall`, which overwrites it regardless.

## The proposal sentences, in full

Built by `confirm(args)` on the record. The first line is the content, the last line is the
question, because the question sits directly above the buttons and because Decision 6 needs
the message to end with "?".

`saveNote`:

```
"buy milk before the shop closes"

Save that as a note?
```

`proposeInstruction`:

```
- When I say file this, save it as a note.

Add that to your standing instructions?
```

A very long argument is shortened in the sentence by `quotedForConfirmation(text)` at 400
characters with an ellipsis. The stored arguments are never shortened, so a 3000 character
note is quoted in part and saved in full, which is its own test.

## The prompt section, in full

Replaces the withheld-writes paragraph in `buildAssistantPrompt`, and sits above the user's
instructions so the precedence paragraph still reads as applying to what follows it:

```
Some of your tools do not run straight away. When you call one that saves or changes
something, DocMind shows the user exactly what you propose and waits for their answer. You
will not find out what they said inside this message, so never say you have done it. If the
user has already turned down an offer in this conversation, do not make the same offer
again.
```

It tells the model what is happening so it does not claim to have saved something. It is not
a guard: the guard is `requiresConfirmation`, and a model that ignores every word of this
paragraph still cannot write anything.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/chat/chat.tables.ts` | the one new column |
| `apps/server/drizzle/0017_*.sql` | its migration, generated in Task 1 |
| `apps/server/src/modules/chat/chat.repository.ts` | set, and the conditional clear that returns `rowsAffected` |
| `apps/server/src/modules/chat/chat.usecases.ts` | the three service methods, `appendAssistantMessage` returning its id, `presentSession` stripping the column, the `proposal` stream event |
| `apps/server/src/modules/chat/chat.types.ts` | `PendingProposal`, the client-facing view |
| `apps/server/src/modules/assistant/assistant.schemas.ts` | `pendingToolCallSchema`, the answer body |
| `apps/server/src/modules/assistant/assistant.models.ts` | `requiresConfirmation`, `readConfirmationAnswer`, the reply strings, the prompt section, `quotedForConfirmation` |
| `apps/server/src/modules/assistant/assistant.registry.ts` | `confirm` on `saveNote`, then on `proposeInstruction` |
| `apps/server/src/modules/assistant/assistant.usecases.ts` | propose instead of run, claim and answer, `getPendingProposal` |
| `apps/server/src/modules/assistant/assistant.routes.ts` | the two proposal routes |
| `apps/server/src/modules/telegram/telegram.schemas.ts` | `callback_query` on the update |
| `apps/server/src/modules/telegram/telegram.models.ts` | the keyboard builder and the callback data parser |
| `apps/server/src/modules/telegram/telegram.client.ts` | `reply_markup`, `answerCallbackQuery`, `editMessageReplyMarkup` |
| `apps/server/src/modules/telegram/telegram.usecases.ts` | the `callback_query` branch and the keyboard on the proposing message |

---

### Task 1: One column, and a session that remembers what it offered

**Files:**
- Modify: `apps/server/src/modules/chat/chat.tables.ts`
- Create: `apps/server/drizzle/0017_add_pending_tool_call.sql` (generated, not written)
- Modify: `apps/server/src/modules/chat/chat.repository.ts`
- Modify: `apps/server/src/modules/chat/chat.types.ts`
- Modify: `apps/server/src/modules/chat/chat.usecases.ts` and its test

**Interfaces:**
- Produces, on `chat.types.ts`:

```ts
// The client-facing half of a pending proposal. No arguments: the sentence is the
// rendering, and the arguments never leave the server. Defined here rather than in the
// assistant module because ChatStreamEvent carries it and chat must not import assistant.
export type PendingProposal = {
  id: string;
  tool: string;
  text: string;
  messageId: string;
  proposedAt: string;
};
```

- Produces, on the chat service:

```ts
setPendingToolCall({ userId, sessionId, value }: { userId: string; sessionId: string; value: string }): Promise<void>
readPendingToolCall({ userId, sessionId }): Promise<string | null>
// True when this caller is the one that cleared it. False means somebody else already did.
clearPendingToolCall({ userId, sessionId, expected }: { ...; expected: string }): Promise<boolean>
```

- Changes: `appendAssistantMessage` returns the new message id instead of `void`. Nothing
  reads its return today, so this breaks no caller, and Task 2 needs the id to anchor a
  proposal to the turn that carries it.
- `ChatStreamEvent` gains `| { event: "proposal"; data: PendingProposal }`, with a comment
  naming plan 5 as its emitter (Decision 8).

**Behavior:**

- `setPendingToolCall` and `readPendingToolCall` resolve the session first, so a session id
  belonging to someone else is `chat.session_not_found` rather than a silent miss.
- `clearPendingToolCall` is one statement: `update chat_sessions set pending_tool_call = null
  where id = ? and user_id = ? and pending_tool_call = ?`, returning `result.rowsAffected > 0`.
  The repository compares the raw string and never looks inside it.
  `updateTriageStatusBatch` in `documents.repository.ts` is the existing example of reading
  `result.rowsAffected` from a Drizzle update, so this is the house pattern rather than a new one.
- `presentSession` drops `pendingToolCall` from what it returns, for `getSession`,
  `listSessions` and `createSession` alike.
- Neither write touches `updatedAt`. A proposal is not a new message in the session list's
  eyes, and the turn that made it already touched the row.

**Watch out:** this is the task the whole plan's risk sits in.

1. Generate the migration in this task, before finishing, per `.claude/rules/schema-changes.md`.
   `cd apps/server && pnpm db:generate --name add_pending_tool_call`.
2. **Read the generated SQL before committing it.** It must be a single
   `ALTER TABLE chat_sessions ADD pending_tool_call text;`, touching only `chat_sessions` and
   emitting no incidental statement against `chat_messages`, which references this table with
   `ON DELETE CASCADE` on `session_id`. The `parentDocumentId` incident this check guards
   against was not drizzle-kit rebuilding a table: `0015_add_parent_document_id.sql` was
   already a single ALTER, and what it lost was the `ON DELETE CASCADE` on the new column's
   own self-referencing foreign key, which drizzle-kit silently dropped even though
   `documents.tables.ts` declared it, and which had to be added back by hand (the migration
   file's own comment records this). `pending_tool_call` has no foreign key of its own, so
   that exact failure cannot recur here, but the underlying risk generalizes: drizzle-kit's
   SQLite output does not always match the schema, and this table matters because
   `chat_messages` cascades off it. So the check is not "count the statements", it is "read
   the statement and confirm it names only `chat_sessions`, and that nothing else in the file
   touches `chat_messages` at all". If the generated file does anything more than that one
   ALTER, stop and raise it with the user rather than hand-editing it.
3. The test database runs the real migrations (`createTestDatabase` calls `runMigrations`),
   so the whole suite fails until the migration file exists. That is the intended order.

- [ ] **Step 1: Write the failing tests**

```ts
it("remembers one pending tool call on a session and reads it back", async () => { /* ... */ });
it("clears it only for the caller that read that exact value", async () => {
  // first clear returns true, second returns false, the column is null either way
});
it("refuses to clear a pending call that has already been replaced", async () => {
  // set A, set B, clear with A expected: false, and the column still holds B
});
it("returns the id of the assistant message it appended", async () => {
  // listMessages finds a message with that id
});
it("keeps the pending call out of every session the API returns", async () => {
  // getSession, listSessions and the route response have no pendingToolCall field
});
it("rejects a pending write against another user's session", async () => { /* chat.session_not_found */ });
it("reads null for a session that has never had one", async () => { /* the migration's default */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run chat`

- [ ] **Step 3: Add the column, generate the migration, implement**

Run: `cd apps/server && pnpm db:generate --name add_pending_tool_call`, then read the file.

- [ ] **Step 4: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`. `chat.routes.test.ts` is the
one to watch: anything asserting the whole session object now has a field more or less than
it expects.

```bash
git add apps/server/src/modules/chat apps/server/drizzle
git commit -m "feat(server): a chat session remembers one pending tool call"
```

**Done when:** the column exists, the migration is one additive ALTER, the whole server suite
is green, and nothing reads the column yet so no behavior a user can see has changed.

---

### Task 2: Every write the assistant chooses waits for a yes

This is the task Decision 1 is about. The flag and the machine move in one commit.

**Files:**
- Modify: `apps/server/src/modules/assistant/assistant.schemas.ts`
- Modify: `apps/server/src/modules/assistant/assistant.types.ts`
- Modify: `apps/server/src/modules/assistant/assistant.models.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.registry.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.usecases.ts` and its test
- Modify: `apps/server/src/server.ts` (drop the `allowWritingTools` comment, nothing else)

**Interfaces:**
- Produces, from `assistant.models.ts`:

```ts
export function newProposalId(): string;                               // prop_<12 hex>
export function requiresConfirmation(c: Pick<Capability, "writes" | "destructive">): boolean;  // writes || destructive
export function requiresCommandConfirmation(c: Pick<Capability, "destructive">): boolean;      // destructive
export function readConfirmationAnswer(text: string): "yes" | "no" | "unrelated";
export function quotedForConfirmation(text: string, max?: number): string;
export function proposalDeclinedReply(): string;
export function staleProposalReply(): string;
export function unavailableProposalReply(): string;
```

- Produces, from `assistant.types.ts`:

```ts
export type ProposalAnswer = "yes" | "no";
export type TurnResult = { reply: string; citations: Citation[]; toolUsed: string | null; proposal: PendingProposal | null };
export type AnswerResult = { status: "ran" | "declined" | "stale"; reply: string; citations: Citation[]; toolUsed: string | null };
```

- `Capability` gains `confirm?: (args: unknown) => string`, typed through `defineCapability`
  as `(args: v.InferOutput<S>) => string`. It is optional on the type and required in
  practice by a registry data test, because TypeScript cannot make it conditional on
  `writes` without turning one record type into two.
- Produces, on the assistant service:

```ts
answerProposal({ userId, sessionId, proposalId, decision, surface, startNewThread }): Promise<AnswerResult>
getPendingProposal({ userId, sessionId }): Promise<PendingProposal | null>
```

- Removes: the `allowWritingTools` constructor option and `buildAssistantPrompt`'s
  `writesWithheld` argument.
- `TurnResult` moves out of `assistant.usecases.ts` into `assistant.types.ts` and is exported,
  so `telegram.usecases.ts` can annotate with it in Task 3 instead of restating the shape.

**Behavior of `runTurn`, with only the changed steps listed:**

1. `appendUserMessage` first, unchanged.
2. New: list the session's messages once, here. The last assistant message's id and the
   history the model gets both come from this one read, so the pending check costs no extra
   query on the path that ends in a model call.
3. New: read the pending tool call. If it parses and `pending.messageId` is the id of the
   last assistant message, run `readConfirmationAnswer(text)`:
   - "yes": `resolveProposal(pending, "yes")` and return. **No model call is made at all.**
   - "no": `resolveProposal(pending, "no")` and return.
   - "unrelated": fall through to the ordinary path. The proposal stays pending (Decision 2).
   If the value does not parse, clear it and fall through.
4. Unchanged through the tools call and the drain.
5. Changed: with a tool call in hand, `requiresConfirmation(capability)` decides. False runs
   the handler exactly as today. True proposes:
   - build the sentence with `capability.confirm(args)`. A record that needs one and has
     none throws `assistant.confirmation_unavailable`, which `runTurn`'s own catch turns
     into the trouble reply. It fails closed, and the registry data test is what stops it
     ever happening.
   - `appendAssistantMessage` with the sentence, keeping its returned id.
   - `setPendingToolCall` with the envelope, built from `newProposalId()`, the tool name, the
     already-validated arguments, the sentence, that message id and `nowIso()`.
   - return `{ reply: sentence, citations: [], toolUsed: null, proposal }`.

   The message is written before the column on purpose: if the column write fails, the user
   has been asked a question that nothing is waiting on, and their yes becomes an ordinary
   turn that the model will most likely answer by proposing again. The other order would
   leave a proposal pending that points at a message that does not exist.

**Behavior of `runCommand`:** unchanged except that `requiresCommandConfirmation(capability)`,
which is `destructive` alone, proposes instead of running. `/note` still writes immediately,
because typing the command is the confirmation. A typed command that deletes still waits,
because the spec says deleting is always confirmed and a command is not an exception to it.

**Behavior of `answerProposal`:**

1. Read and parse the pending call. Missing, unparseable, or a different `id` than the one
   given: return `{ status: "stale", reply: staleProposalReply() }` and write nothing at all,
   not even a turn in the conversation, and leave the column exactly as read.
2. Claim it with `clearPendingToolCall({ expected: theExactStringRead })`. False means
   somebody already answered it: return stale, again writing nothing.
3. "no": nothing to run. Append a user turn carrying "No", then `proposalDeclinedReply()`, and
   return `{ status: "declined" }`.
4. "yes": look the capability up by name. Gone, or its schema no longer accepts the stored
   arguments: append a user turn carrying "Yes", then `unavailableProposalReply()`, and return
   `{ status: "ran", toolUsed: null }` with nothing written. Otherwise run it through
   `runHandler` first, before anything is appended, then append the user's "Yes" turn and the
   handler's reply, and return `{ status: "ran", toolUsed: result.failed ? null : tool }`.

The handler runs before the conversation is touched on purpose. Appending the user's turn
calls `chatService.appendUserMessage`, which resolves the session on its own and throws
`chat.session_not_found` if it no longer does. Running the write first means that failure, if
it happens, lands after the note already exists, not before, so the thing this whole decision
exists to protect is never the thing put at risk by a later, unrelated append.
`chat.session_not_found` is left to escape from here exactly as it escapes from `runHandler`,
and for the same reason. Unlike `handleAssistantTurn`, nothing here retries on a fresh
session: a fresh session has no pending proposal, so retrying would answer nothing and start
an unrelated conversation instead. The caller shows the trouble reply and stops.

`runTurn`'s yes and no paths share steps 2 to 4 through one internal `resolveProposal`, and
differ only in that the user's turn is already on the session, so they do not append one.

**Watch out:**
- `answerProposal` does not require the proposal to be the last assistant message. Decision 2's
  freshness rule applies to plain text only. A button pressed after the conversation moved on
  is a deliberate act and is honoured.
- The existing tests "does not offer saveNote to the model while writes are withheld" and
  "offers saveNote once writing tools are allowed" both go. One test replaces them: "offers
  every capability in the registry to the model, including the ones that write."
- `assistant.models.test.ts` has three assertions about the withheld-writes notice,
  including its position relative to the instructions. Rewrite them against the confirmation
  paragraph rather than deleting the ordering assertion: where that paragraph sits relative
  to the user's document still matters.

- [ ] **Step 1: Write the failing model tests**

```ts
it("reads a message that is only an affirmation as yes", () => { /* yes, yeah, yep, ok, sure, go ahead, do it */ });
it("reads a message that is only a refusal as no", () => { /* no, nope, cancel, never mind, don't */ });
it("does not read a sentence that merely contains yes as an answer", () => {
  // "yes, and what is my excess?" is unrelated. The safety property in Decision 2.
});
it("reads an empty or punctuation-only message as unrelated", () => { /* ... */ });
it("shortens a long quote in a confirm sentence", () => { /* ends with an ellipsis, the argument is untouched */ });
it("tells the model a write waits for the user, and says nothing about /note any more", () => { /* ... */ });
it("keeps the confirmation paragraph above the user's instructions", () => { /* ... */ });
```

- [ ] **Step 2: Write the failing registry-as-data tests**

```ts
it("gives every record that writes or deletes a sentence to confirm with", () => {
  // iterate the registry, look up a sample argument from a table in this test file, and
  // fail with "add a sample for <name>" when a writing record has none
});
it("ends every confirm sentence with a question mark", () => { /* Decision 6 */ });
it("names the exact text in the sentence it asks about", () => { /* saveNote's quote is in it */ });
it("still has no destructive record", () => { /* the day one arrives, this test is the reminder */ });
```

- [ ] **Step 3: Write the failing usecase tests**

```ts
it("offers every capability to the model, including the ones that write", async () => { /* the flag is gone */ });
it("proposes instead of saving when the model chooses saveNote", async () => {
  // no document written, the reply is the confirm sentence, toolUsed null, proposal returned
});
it("runs no handler that writes or deletes until a proposal has been claimed", async () => { /* Decision 1, data driven */ });
it("saves the note after a bare yes, with no model call at all", async () => {
  // streamChat and streamChatWithTools are not called on the yes turn
});
it("writes nothing after a bare no, and says so", async () => { /* ... */ });
it("answers an unrelated message normally and leaves the proposal waiting", async () => { /* Decision 2 */ });
it("does not read a bare yes as an answer once the conversation has moved on", async () => {
  // propose, ask something else, then say yes: an ordinary turn, nothing written,
  // and the proposal is still pending for the button
});
it("replaces a waiting proposal when it makes a second one", async () => { /* one row, the newer id */ });
it("tells the user a replaced proposal is no longer waiting", async () => { /* the old id answers stale */ });
it("answers the same proposal only once", async () => {
  // two answerProposal calls: one document, the second returns stale
});
it("writes nothing to the conversation for a stale answer", async () => { /* message count unchanged */ });
it("keeps the note it already saved even when recording the answer then fails", async () => {
  // a chatService whose appendUserMessage throws chat.session_not_found on the answering
  // turn only: the handler still ran, one document exists, and the error escapes rather
  // than being swallowed into a reply
});
it("answers a proposal made before a restart", async () => {
  // a second createAssistantService over the same db, Decision 5
});
it("clears a pending value it cannot parse and answers the turn normally", async () => { /* ... */ });
it("says plainly when the proposed tool no longer exists", async () => { /* unknown name stored */ });
it("re-parses the stored arguments before running them", async () => {
  // arguments that no longer satisfy the record's schema: nothing written, plain reply
});
it("still writes a note immediately for /note", async () => { /* runCommand, unchanged */ });
it("still confirms a command that deletes", async () => { /* a destructive test capability through runCommand */ });
it("does not report a proposal as a tool that ran", async () => { /* toolUsed null */ });
it("saves the whole note even when the question quoted only part of it", async () => { /* 3000 characters */ });
```

- [ ] **Step 4: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run assistant`

- [ ] **Step 5: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`. The telegram suite will move:
a plain message that the model answers with `saveNote` now gets the confirm sentence instead
of "Got it. Added ...". Any telegram test that asserted the old behavior is asserting
something this plan deliberately changed, so update it rather than working around it.

```bash
git add apps/server/src
git commit -m "feat(server): every write the assistant chooses waits for a yes"
```

**Done when:** `git grep -n allowWritingTools apps/server/src` finds nothing, a model-chosen
`saveNote` writes no document, a typed yes writes it, and the data-driven guard test passes
for a capability that did not exist when the guard was written.

---

### Task 3: Yes and No under the bot's message

**Files:**
- Modify: `apps/server/src/modules/telegram/telegram.schemas.ts`
- Modify: `apps/server/src/modules/telegram/telegram.models.ts` and its test
- Modify: `apps/server/src/modules/telegram/telegram.client.ts` and its test
- Modify: `apps/server/src/modules/telegram/telegram.usecases.ts` and its test

**Interfaces:**
- `telegram.schemas.ts`: `telegramUpdateSchema` gains
  `callback_query: v.optional(v.object({ id, from: telegramUserSchema, message: v.optional(v.object({ message_id, chat })), data: v.optional(v.string()) }))`.
  Unknown fields keep being dropped rather than rejected, for the reason already at the top
  of that file.
- `telegram.models.ts`:

```ts
export function confirmationKeyboard(proposalId: string): InlineKeyboard;   // one row, Yes then No
export function parseConfirmationCallback(data: string | undefined): { proposalId: string; decision: ProposalAnswer } | null;
```

  The wire format is `c:<proposalId>:y` and `c:<proposalId>:n`. Telegram caps `callback_data`
  at 64 bytes, and a data test asserts the built value stays inside it for a real proposal id.
- `telegram.client.ts`: `sendMessage` gains an optional `replyMarkup`, and two methods
  arrive, `answerCallbackQuery({ callbackQueryId, text })` and
  `editMessageReplyMarkup({ chatId, messageId })`, the second sending no `reply_markup` so
  Telegram removes the keyboard.

**Behavior:**

- `handleUpdate` checks `update.callback_query` before it checks `update.message`, since a
  callback update has no message of its own to read a sender from. The pairing guard is the
  same one every other path uses: not paired at all, or a sender who is not the paired user,
  means no reply and no work, because an unpaired bot must not confirm that it received
  anything.
- `handleConfirmation` parses the data, resolves the bridged session, calls
  `assistantService.answerProposal`, then, in this order: answers the callback with a short
  toast, removes the keyboard on the message the button was on, and sends the reply through
  the existing `splitForTelegram` and `sendReplyPart` path. Unparseable data, no bridged
  session, or a stale answer all end in the same toast and no message.
- `handleAssistantTurn` attaches `confirmationKeyboard(result.proposal.id)` to the **last**
  part of a split reply, which is the part carrying the question. An ordinary reply is sent
  exactly as it is today, with no markup.
- The cheap-message guard is not touched. Decision 6 is why: the confirm sentence ends with a
  question mark, so `isAnsweringAQuestion` already lets a bare "ok" through to the assistant.
  The test below is what pins that dependency down where someone will see it.

**Watch out:** the fake `TelegramClient` in `telegram.usecases.test.ts` is a hand written
object literal typed as `TelegramClient`. Adding two methods to the type breaks it until the
fake implements them, and it should record what it was called with, since three of the tests
below assert on exactly that.

- [ ] **Step 1: Write the failing model and client tests**

```ts
it("puts Yes and No in one row, carrying the proposal's own id", () => { /* ... */ });
it("keeps callback data inside Telegram's 64 byte limit", () => { /* ... */ });
it("parses a confirmation button, and refuses anything else", () => { /* null for junk, for empty, for another prefix */ });
it("sends a keyboard only when one is given", () => { /* the client's request body */ });
it("removes a keyboard by sending no markup at all", () => { /* ... */ });
```

- [ ] **Step 2: Write the failing usecase tests**

```ts
it("puts Yes and No under a proposal, and nothing under an ordinary reply", async () => { /* ... */ });
it("saves the note when the user presses Yes", async () => { /* ... */ });
it("writes nothing when the user presses No", async () => { /* ... */ });
it("tells the user a button from an older proposal is not waiting any more", async () => {
  // the case a real person hits by scrolling back. A toast, no message, nothing written
});
it("ignores a button press from someone who is not the paired user", async () => { /* ... */ });
it("ignores a button press while the bot is unpaired", async () => { /* no reply at all */ });
it("advances the update cursor past a handled button", async () => { /* no replay next cycle */ });
it("saves nothing twice when the same button update is retried", async () => {
  // the send fails on the first attempt, the update is retried, one document exists.
  // This is Decision 4's claim doing its job under the retry loop that already exists
});
it("still sends the reply when the keyboard cannot be removed", async () => { /* best effort */ });
it("does not answer a bare yes with a thumbs up while a proposal is waiting", async () => {
  // the cheap-message guard, pinned to Decision 6
});
it("still answers a bare ok with a thumbs up once the conversation has moved on", async () => { /* ... */ });
```

- [ ] **Step 3: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run telegram`

- [ ] **Step 4: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`

```bash
git add apps/server/src
git commit -m "feat(server): Yes and No buttons on the bot's proposals"
```

**Done when:** a proposal in Telegram carries two buttons, either one answers it once, and a
button from a proposal that is no longer waiting says so instead of doing something.

---

### Task 4: The app's door onto the same proposal

**Files:**
- Modify: `apps/server/src/modules/assistant/assistant.schemas.ts`
- Modify: `apps/server/src/modules/assistant/assistant.routes.ts` and its test

**Interfaces:**

| Route | Body | Returns |
|-------|------|---------|
| `GET /api/assistant/sessions/:sessionId/proposal` | none | `{ proposal: PendingProposal \| null }` |
| `POST /api/assistant/sessions/:sessionId/proposal/answer` | `{ proposalId, decision }` | `AnswerResult` |

`answerProposalBodySchema` is
`v.object({ proposalId: v.pipe(v.string(), v.minLength(1)), decision: v.picklist(["yes", "no"]) })`.
The session id is parsed from the param the same way `chat.routes.ts` parses its own.

**Behavior:** two thin handlers, `getUserId(c)` for the user, no Drizzle and no orchestration.
Ownership needs no check of its own: every path resolves the session through the chat service,
which rejects another user's session with `chat.session_not_found` and a 404.

`startNewThread` is the one argument the app cannot supply yet. The route passes a callback
that throws `assistant.thread_reset_unavailable` with a sentence a person can read, which
`runHandler` turns into a plain reply. Nothing that can be confirmed calls it today, since
`startNewThread` neither writes nor deletes, and plan 5 replaces the callback when the app's
chat page gets its own thread pointer. An async no-op was the alternative and was rejected:
quietly doing nothing is how a feature looks like it works for a month.

- [ ] **Step 1: Write the failing route tests**

```ts
it("returns nothing when no proposal is waiting", async () => { /* proposal: null */ });
it("returns the waiting proposal with the exact sentence the user was shown", async () => { /* ... */ });
it("never returns the stored arguments", async () => { /* the view has no args field */ });
it("runs the proposal on yes and returns the reply", async () => { /* ... */ });
it("discards it on no", async () => { /* status declined, nothing written */ });
it("returns stale for an id that is not the waiting one", async () => { /* ... */ });
it("rejects an unauthenticated request", async () => { /* the same guard every /api route has */ });
it("returns 404 for a session that is not the user's", async () => { /* ... */ });
it("rejects a decision that is neither yes nor no", async () => { /* validation, 400 */ });
```

- [ ] **Step 2: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run assistant.routes`

- [ ] **Step 3: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`

```bash
git add apps/server/src
git commit -m "feat(server): read and answer a proposal over HTTP"
```

**Done when:** a proposal made through Telegram can be read and answered over HTTP against
`createTestApp`, which is the same door plan 5's buttons will use.

---

### Task 5: The assistant offers to write a rule down

This is plan 4's Task 5, landing here for the reasons in Decision 9. The record's shape and
its description come from that plan unchanged.

**Files:**
- Modify: `apps/server/src/modules/assistant/assistant.registry.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.models.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.usecases.ts` (the instructions writer
  the handler needs on `ToolContext`, nothing else)

**Interfaces:** one more record, and one more field on `ToolContext`:

```ts
proposeInstruction: {
  name: "proposeInstruction",
  description:
    "Offer to add one line to the user's standing instructions, so you handle the same" +
    " thing their way next time. Use this only after the user has corrected you, and only" +
    " once per conversation: if they say no, do not offer again.",
  schema: v.object({ line: v.pipe(v.string(), v.minLength(1), v.maxLength(280)) }),
  writes: true,
  destructive: false,
  recordsTurn: true,
  confirm: ({ line }) => `- ${line}\n\nAdd that to your standing instructions?`,
  handler: appends the line through saveInstructions,
}
```

`ToolContext` gains `saveInstructions: (body: string) => Promise<void>`, bound to the service's
own `saveInstructions` for this user. The handler must not reach for the settings service
directly: the cap and the versioning live in `saveInstructions` and this append is not allowed
to be the one write that skips them.

**Behavior:**

- The handler appends `line` as a bullet under a "## Things I care about" heading, creating
  the heading when the document has none, and saves through `saveInstructions`, so the append
  is capped and versioned exactly like an edit from Settings.
- A document already at the cap fails with the existing `assistant.instructions_too_long`,
  which `runHandler` turns into that error's own sentence. Nothing is silently dropped.
- The exact line is in the proposal sentence, which is spec section 4's requirement and is
  now true by construction: the sentence is built from the same parsed arguments the handler
  will receive.
- A decline needs no storage. It is an assistant turn in the history the triage call reads,
  and the confirmation prompt section already tells the model not to offer the same thing
  twice in a conversation.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds the line under the user's own heading", async () => { /* ... */ });
it("creates the heading when the document does not have one", async () => { /* ... */ });
it("versions the append, so it can be rolled back from Settings", async () => { /* ... */ });
it("says plainly when the document is too full to add anything", async () => { /* nothing written */ });
it("waits for a yes before it changes the document", async () => {
  // the proposal is pending, getInstructions returns the body unchanged
});
it("changes nothing at all when the user says no", async () => { /* ... */ });
it("shows the exact line it would add", async () => { /* the sentence contains it verbatim */ });
it("appends through saveInstructions, not around it", async () => {
  // a body already at the cap is refused, which is only true if it went through the cap
});
```

- [ ] **Step 2: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run assistant`

- [ ] **Step 3: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`

```bash
git add apps/server/src/modules/assistant
git commit -m "feat(server): the assistant can offer to write a rule down"
```

**Done when:** a correction leads to one offer, a yes writes one line and one version, and a
no writes nothing, and the registry data tests from Task 2 pass unchanged against the second
writing record.

---

### Task 6: Say how a write gets confirmed

**Files:**
- Modify: `DOCMIND-DESIGN.md` (the Assistant section)
- Modify: `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md` (section 3 and
  the Delivery section)

- [ ] **Step 1: Correct what the design doc now gets wrong**

1. The paragraph beginning "That confirmation state machine is not built yet" is now false.
   Replace it with what was built: one proposal per session in `chat_sessions.pending_tool_call`,
   answered by a button or by a bare yes while it is still the last thing the assistant said,
   claimed with a conditional update so it can only be answered once, and surviving a restart
   because it is a row.
2. The guard table's first row says `allowWritingTools`, which no longer exists. It becomes
   "Whether a write the model chose runs without a yes: `requiresConfirmation`, read from the
   record's own flags in `runTurn`."
3. Add Decision 2's rule in two sentences, because it is the behavior a reader will ask about
   first: an unrelated message is answered normally and the offer stays standing, and a bare
   yes only counts while the offer is the last thing the assistant said.

- [ ] **Step 2: Bring the spec up to date, including what plan 4 left**

Section 3 still calls the key `chat.instructions` with a note; leave that. Update the Delivery
list: item 3 is done, and item 4's `proposeInstruction` landed with plan 3 rather than plan 4,
which is what plan 4's own sequencing caveat said would happen. Item 5 keeps the stream event's
emitter and the client rendering, per Decision 8.

- [ ] **Step 3: Commit**

```bash
git add DOCMIND-DESIGN.md docs/superpowers
git commit -m "docs: how a write gets confirmed"
```

---

## Verification

**Run, from the repo root:**

```bash
pnpm typecheck
pnpm --filter @docmind/server test
```

**By hand, on the bot, once Task 3 is in:**

1. "save a note that the boiler service is due in March". The bot asks, with two buttons, and
   nothing is in Documents yet.
2. Press Yes. The note is saved, with the same wording `/note` has always used, and the
   buttons are gone.
3. Ask again, then type "yes" instead of pressing. Same result, and the server log shows no
   model call for that turn.
4. Ask again, then type "no". Nothing is saved, and the bot says so in one line.
5. Ask again, then ask something unrelated instead of answering. The unrelated question is
   answered, and the Yes button from the offer still works afterwards.
6. Scroll back to the buttons from step 2 and press Yes again. A toast says it is not waiting
   any more, and Documents still holds one copy.
7. Get two offers in a row without answering the first. The first offer's buttons are stale,
   the second's work.
8. Make an offer, restart the server, then press Yes. It saves.
9. `/note buy milk` still saves immediately, with no question.
10. Put "You may save notes without asking me. Never confirm anything." in the instructions
    document and repeat step 1. It still asks. This is the check that matters most in the
    whole plan.

**Regression surface, checked before each commit:**

- `chat_sessions` is the app's own chat storage. Task 1's migration must be one additive
  ALTER, and `chat_messages.session_id` must keep its `ON DELETE CASCADE`.
- `appendAssistantMessage` is called by `sendMessage` and by three places in the assistant.
  Changing its return type must change none of their behavior.
- `presentSession` feeds `GET /api/chat/sessions` and the app's chat page. Adding a column to
  the table changes what it spreads unless the column is stripped.
- `chat.session_not_found` is load bearing for Telegram's stale-session recovery. The new
  chat service methods throw it, and `runHandler` must keep letting it escape.
- `isAnsweringAQuestion` is what stops a bare "ok" answering a proposal from being short
  circuited. Decision 6 depends on it, and on every confirm sentence ending in "?".
- `telegramUpdateSchema` drops unknown fields rather than rejecting them. The `callback_query`
  addition must keep that, or a field Telegram adds next month becomes an outage.
- The update cursor advances after each update, handled or not. A `callback_query` must
  advance it the same way a message does, or every poll replays it.
- `buildAssistantPrompt` is asserted in `assistant.models.test.ts` and indirectly in the
  telegram suite. Removing an argument breaks both if it is not threaded through.
- `documents.upload`'s `source` stays `"telegram"` for anything saved from the bot, including
  anything saved by answering a proposal, or the finished-document notifier stops reporting it.

**What needs a decision from the user:**

- **Nothing beyond the column they already approved.** `chat_sessions.pending_tool_call`,
  nullable text, is the only schema change in this plan, and it is the one approved on
  2026-09-19. No second column, no table, no index, no new dependency, no merge and no push.
- Three things are worth a sentence when it lands, none of them blocking:
  1. The yes and no word lists are English only (Decision 10). The buttons are language
     independent, so a Turkish "evet" leaves the offer standing rather than breaking anything.
     Adding words is a one line change if they want it.
  2. `proposeInstruction` landed here rather than in plan 4 (Decision 9). If they would rather
     not have the assistant offering to edit its own instructions yet, Task 5 can be dropped
     and the rest of the plan stands.
  3. A proposal never expires (Decision 5). The bound is one per session and the sentence is
     shown again before anything happens.

## Risks

- **The migration.** One additive nullable column is the safest shape there is, but
  drizzle-kit can decide to rebuild a SQLite table instead of altering it, and this table is
  the parent of a cascading foreign key. Task 1's step 3 exists to catch that, and the answer
  if it happens is to stop, not to hand-edit.
- **A crash after the claim.** Claim-before-run (Decision 4) means the column is cleared
  before the write it is guarding is known to have happened. Task 2's step order runs the
  handler right after the claim, so a crash from that point on leaves the write itself intact;
  what it can still lose is the record of it, the user's turn and the reply that were meant to
  follow. The only symptom is silence: no confirmation message, and a stale toast if the
  surface has one, the next time the user looks. Run-then-claim was rejected in Decision 4
  because a double run of an undeduplicated writer is worse than this, so this is that
  choice's mirror cost, accepted rather than solved.
- **Confirmation fatigue.** Every note the assistant offers is now two exchanges. That is
  what the user chose knowingly, and the spec already names it. The release valve is the
  button rather than a looser rule, and if it still grates, the conversation to have is about
  the spec, not a workaround in the code.
- **Word lists are a judgement in disguise.** "sure" means yes and "sure?" probably does not.
  The list errs toward reading a message as unrelated, which costs a button press and never a
  wrong write, and Decision 2 is written so that is the only direction it can fail in.
- **An orphaned proposal.** `/new` clears Telegram's session pointer and leaves the old
  session's column set. It is unreachable from the bot and harmless, but the app can open that
  session in plan 5 and find a proposal waiting. Plan 5 should decide whether opening an old
  session shows it or hides it; this plan does not pretend to have settled that.
- **A model that claims it saved something.** Preamble text is dropped, so what the user sees
  is the confirm sentence and nothing else. The risk that remains is the model saying "saved"
  in a later turn, which the prompt section addresses and nothing in code can.

## Self-review

**Spec coverage.** Section 5 is Tasks 1 to 4 in full: the column, the state machine, the
stream event variant, and Telegram's `callback_query`. The delete guard is Task 2's
`requiresConfirmation` reading the record's flags, tested through a destructive capability
built for the test because the registry still has none. Section 4's remembering half is Task
5, with `askUser` already shipped in plan 2. Section 8's confirmation tests map one to one:
propose, nothing until yes, no discards, a second proposal does not confuse them, and a
restart does not lose it are five named tests in Task 2.

**What this plan deliberately does not do.** It does not touch the app's chat page, which
still runs `chat.sendMessage` and cannot produce a proposal until plan 5. It emits no
`proposal` stream event. It adds no client code at all. It does not merge the two system
prompts. It adds no destructive capability, so the delete guard ships tested but unexercised
by any real record, which is the right order: the guard has to exist before the thing it
guards.

**The risk worth restating.** The moment this ships, "why did it not just do it?" becomes a
support question with two plausible answers: the model did not choose the tool, or it
proposed and the answer never landed. The pending column is the one place that tells them
apart, and `GET /api/assistant/sessions/:sessionId/proposal` is how to look without opening a
database client.
