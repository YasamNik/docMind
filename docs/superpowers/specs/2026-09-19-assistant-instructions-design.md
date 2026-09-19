# The assistant: triage, tools, and instructions

Date: 2026-09-19
Feature list: extends #19. Introduces the layer the later secretary features (#20 calendar,
#21 tasks, #22 morning brief, #32 renewals) plug into.

## Why

The assistant answers questions and takes `/note`. Everything else needs a command prefix,
and a secretary you issue commands to is a command line with manners. The user's words:

> "behind the chat we have a powerful LLM that I'd like to do its own triage to understand
> what type of question / conversation is that: document related, adding new note, adding
> new reminder or adding documents etc... user will be able to add new rules and
> instructions for the chat... that will make the chat adaptable to the user as a real
> secretary. If not sure how to triage the message just ask user. if user ask something
> often or some specific request, the chat may propose to add it in instructions as a rule
> for future."

## What the user decided

- **Instructions are a markdown document edited in Settings**, versioned.
- **When unsure, ask, then remember.**
- **One brain for both surfaces**, confirmed knowing it changes the in-app chat: that page
  stops refusing questions its documents cannot answer and gains the same tools as the bot.
- **Every write confirms**, stricter than recommended, chosen knowingly.
- **One nullable column on `chat_sessions`** to hold a pending confirmation. Approved
  2026-09-19.

## What the first review corrected

A first draft claimed the tools "all exist today". The usecases do. The wire protocol does
not, and that is the largest piece of work here.

**Neither adapter supports tool calling.** `openai-compatible.adapter.ts` builds
`{ model, messages, stream: true, max_tokens }` and yields only
`chunk.choices[0]?.delta?.content`. `anthropic.adapter.ts` yields only
`content_block_delta` text. `AiProviderCapabilities` has no `tools` flag. This spec now
treats tool calling as new work in the AI layer, sequenced first.

**The model can do it.** Checked against OpenRouter's model list: the configured chat slot,
`~deepseek/deepseek-pro-latest`, reports `tools` in `supported_parameters`. So the
destination is known rather than hoped for.

## Design

### 1. Tool calling in the AI layer

`streamChat` currently yields strings. It becomes a typed event stream:

```ts
type ChatStreamPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };
```

Each adapter reassembles its own provider's representation into that shape. They are two
different parsing problems and the abstraction is the point: OpenAI-style calls arrive as
fragmented deltas carrying index, id, name and argument chunks that must be concatenated
into valid JSON before use, while Anthropic sends discrete `tool_use` content blocks. The
caller sees neither.

Arguments are parsed with the tool's valibot schema. A malformed call is retried once with
the parse error fed back, then reported honestly rather than guessed at.

**A `supportsTools` capability, checked before offering tools.** Not every model on
OpenRouter supports them, and a model that silently ignores tools would make the assistant
appear to work while never saving anything. When the configured chat model does not support
tools, the assistant says so plainly and falls back to answering from documents only, the
same way `/web` refuses on a non-OpenRouter slot rather than pretending.

### 2. Triage is tool choice

A classify-then-act design costs two model calls on every message, including "thanks".
Choosing a tool is the triage, in the same call as the answer, and asking a clarifying
question is a tool rather than a branch in our code.

| Tool | Writes | What it does |
|------|--------|--------------|
| `answerFromDocuments` | no | the existing RAG path, the default for anything about the library |
| `saveNote` | yes | what `/note` does now |
| `searchWeb` | no | what `/web` does now, OpenRouter only |
| `startNewThread` | no | what `/new` does now |
| `askUser` | no | one short question when the intent is genuinely ambiguous |
| `proposeInstruction` | yes | offer a rule, never write one silently |

Slash commands stay as exact shortcuts and bypass triage: someone who types `/note` means
it.

**A capability registry, not a switch.** Each tool is a record: name, the description the
model reads, a valibot schema, `writes`, `destructive`, and a handler. Reminders and
calendar later are records. Nothing in the router changes.

**A tool handler produces the user-facing reply itself; a tool-calling turn never feeds
a tool's result back into its own `messages` array.** `saveNote` returns the confirmation
text once it has written the note, `searchWeb` returns the answer once it has the search
result, and so on. Nothing appends the result as a further assistant or user turn and
asks the model to write the reply from it. That keeps the retry path in the AI layer,
which does append a turn to correct invalid arguments, the only place a turn is ever
appended to a caller's messages, and it is the pattern a future tool must follow rather
than reinvent.

### 3. The instructions document

One markdown document in `assistant.instructions`, shipped with an editable default,
appended to the system prompt every turn under a heading marking it as the user's standing
instructions. This document first drafted the key as `chat.instructions`; the implementation
plan renamed it, because every settings key is prefixed with the module that owns it and the
chat module never reads this document, only the assistant module's prompt builder and turn
runner do.

**Versioned.** Each save pushes the previous body onto `assistant.instructionsHistory`,
capped at twenty versions with timestamps. Settings are key value, so no migration.

**Capped, not merely warned about.** The first draft relied on a size warning, which the
review correctly called protection that protects nothing: `MAX_CONTEXT_CHARS` bounds only
the retrieved-chunk block, so an unbounded instructions document is unbounded cost on every
message and eventually a provider error rather than graceful degradation. The document is
therefore refused above 8000 characters on save, with the editor showing the size and
warning from 6000. A cap that the code enforces, not a sentence asking nicely.

**Precedence, stated in the prompt:** the user's instructions beat the defaults, and the
guards in section 5 beat both. An instruction is a prompt and a prompt can be argued with,
so anything that must hold is code.

### 4. Asking, and remembering

Ambiguity calls `askUser` with one short question. The answer arrives as the next turn and
the original request carries through, so nothing is retyped.

Having acted, the assistant may offer once to write the choice into the instructions,
showing the exact line before writing it. A decline is remembered for the thread.

**The trigger is a correction.** "You have asked three times" is hard to measure. "You told
me I got it wrong" is clear.

One honesty correction from the review: this is a weaker analogy to the sorting engine than
the first draft claimed. Sorting detects a correction deterministically, by seeing a
user change what a rule applied. Detecting "no, that was meant as a note" in free text is
itself a model judgment, so it carries the same reliability risk as tool selection. It is a
softer signal wearing the same name, and the offer is always shown before anything is
written, which is what makes that acceptable.

### 5. Confirmation, and the guard that is not negotiable

Every writing tool proposes and waits.

**Where a pending proposal lives:** `chat_sessions.pending_tool_call`, nullable, holding the
tool name and its parsed arguments as JSON until answered, then cleared. One additive column,
approved by the user. It is per session, which settings could not be without inventing
dynamic keys, and a Telegram conversation is already a chat session, so both surfaces use
one mechanism.

- **In the app**, a new `ChatStreamEvent` variant carries the proposal, and the chat stream
  renders a pair of buttons. This is a server to client protocol change, not a UI detail.
- **In Telegram**, an inline keyboard on the message, which means the poll loop must handle
  `callback_query` updates. It does not today. That is real work, and it is the right cost:
  "reply yes" is ambiguous the moment two confirmations overlap.

**Deleting is always confirmed and no instruction can loosen it.** The guard is the
`destructive` flag on the capability record, not a sentence in the prompt.

### 6. One brain, two surfaces

`CHAT_SYSTEM_PROMPT` and `TELEGRAM_ASSISTANT_SYSTEM_PROMPT` merge into one. The in-app chat
gains tools and stops refusing what its documents cannot answer, which the user confirmed
knowing it changes that page.

Document-scoped sessions (`chat_sessions.documentScope`) stay narrow: a session pinned to
particular documents answers from them and does not save notes or search the web. No client
creates one today, so this is a latent case being settled before it becomes a bug.

### 7. What this costs

One call per message, plus one per tool round trip, plus the instructions on every call. The
cheap-message guard (a bare "ok" answered without a model call) matters more now and stays.

### 8. Testing

- The registry is data: every record has a description, a schema, and correct flags.
- Adapter tool parsing, per adapter, from real fragmented deltas rather than pre-assembled
  objects. The link fetcher shipped broken because its tests only met a fake.
- `supportsTools` false: the assistant says so and answers without tools.
- Confirmation as a state machine: propose, nothing happens until yes, no discards, a second
  proposal while one is pending does not confuse them, and a restart does not lose it.
- The delete guard: an instruction saying "never ask before deleting" does not stop it.
- Instructions: save pushes a version, rollback restores, history is capped, the body
  reaches the prompt, and 8001 characters is refused.

## Delivery: five plans

Sequenced by risk, first is the foundation:

1. **Tool calling in the AI layer.** The typed event stream, both adapters, `supportsTools`.
   Validate against the real configured model before anything is built on it.
2. **The capability registry and triage**, wrapping usecases that already exist.
   `saveNote` ships as a real, tested handler here, but it is withheld from the model
   until plan 3 lands `pending_tool_call`: the model is offered every record where
   `writes` is false, and a slash command such as `/note` writes immediately in the
   meantime, since typing the command is itself the confirmation.
3. **Confirmation**: the column, the state machine, the new stream event, Telegram
   `callback_query`.
4. **The instructions document**: storage, versioning, the enforced cap, the Settings editor.
   `proposeInstruction`, the offer-to-write-a-rule tool from section 4, is the last task of
   this plan and waits for plan 3's `pending_tool_call` and confirmation state machine before
   it lands, the same way `saveNote` waited in plan 2.
5. **Prompt unification and the client confirmation UI.**

`DOCMIND-DESIGN.md` gains a section on this layer once plan 1 lands, since it currently says
nothing about the assistant at all.

## Risks

- **Confirmation fatigue.** Every note is two exchanges, by choice. If it grates, the
  instructions loosen it per case and this spec is revisited rather than worked around.
- **Tool calling is model-dependent.** Verified for the current slot; a model change can
  remove it, which is what `supportsTools` exists to catch loudly.
- **The instructions are a prompt.** They can be ignored or argued with. Anything that must
  hold is code.
