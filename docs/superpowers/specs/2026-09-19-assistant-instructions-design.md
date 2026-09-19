# The assistant: triage, tools, and instructions

Date: 2026-09-19
Feature list: extends #19. Introduces the instruction layer the later secretary features
(#20 calendar, #21 tasks, #22 morning brief, #32 renewals) will all plug into.

## Why

The assistant currently answers questions and takes `/note`. Everything else it could do
needs a command prefix, and a secretary you have to issue commands to is a command line
with manners. The user's words:

> "behind the chat we have a powerful LLM that I'd like to do its own triage to understand
> what type of question / conversation is that: document related, adding new note, adding
> new reminder or adding documents etc... user will be able to add new rules and
> instructions for the chat... that will make the chat adaptable to the user as a real
> secretary. If not sure how to triage the message just ask user. if user ask something
> often or some specific request, the chat may propose to add it in instructions as a rule
> for future."

## What the user decided

Asked on 2026-09-19:

- **Instructions are a markdown document edited in Settings**, versioned so a change can be
  seen and rolled back.
- **When unsure, ask, then remember**: act on the answer and offer to write the choice into
  the instructions so the question is not asked twice.
- **One brain for both surfaces.** The in-app chat and the Telegram bot share instructions
  and triage. Only what the medium allows differs.
- **Every write confirms**, including saving a note. Stricter than recommended, chosen
  knowingly: the cost is that every note is two exchanges.

## Design

### 1. Triage is tool choice, not a separate pass

A classify-then-act design costs two model calls on every message, including "thanks". So
the assistant is given tools and the act of choosing one is the triage. One call, one
answer, and asking a clarifying question is itself one of the tools rather than a branch in
our code.

Tools at the start, all of which exist today:

| Tool | What it does |
|------|--------------|
| `answerFromDocuments` | the current RAG path, the default for anything about the library |
| `saveNote` | what `/note` does now |
| `searchWeb` | what `/web` does now, still OpenRouter only |
| `startNewThread` | what `/new` does now |
| `askUser` | ask one short question when the intent is genuinely ambiguous |
| `proposeInstruction` | offer to write a rule, never write one silently |

The slash commands stay as exact shortcuts, because a person who types `/note` means it and
should not be second-guessed. They bypass triage entirely.

**A capability registry, not a switch.** Each tool is a record with a name, a description
the model reads, a valibot schema for its arguments, whether it writes, and a handler.
Adding reminders (#21) or calendar (#20) later means adding a record, exactly as adding a
storage driver means adding a definition. Nothing in the router changes.

### 2. The instructions document

One markdown document per user, in `chat.instructions`, shipped with a default body the
user can edit or delete. It is appended to the system prompt on every turn, under a heading
that marks it as the user's own standing instructions.

**Versioned.** Each save pushes the previous body onto `chat.instructionsHistory`, capped at
the last twenty versions with timestamps, so a bad edit is one click from undone. Settings
are a key value store, so this needs no migration.

**It costs money on every message.** The document rides in the system prompt, so a thousand
words is paid for on every "ok". The editor shows the current size and warns past a
threshold, the same way the sorting page warns about the cost of a large rule set. This is
stated in the editor, not buried here.

**Precedence, stated in the prompt itself:** the user's instructions win over the defaults,
and the safety rules in section 4 win over both. An instruction is a prompt, and a prompt
can be argued with, so anything that must hold is enforced in code rather than asked for in
words.

### 3. Asking, and remembering

When the intent is ambiguous the model calls `askUser` with one short question. The answer
arrives as the next turn and the original request is carried through, so the user does not
repeat themselves.

Having acted, the assistant may offer once: "Want me to always treat messages like that as
a note?" Accepting appends a line to the instructions, shown before it is written. Declining
is remembered for the thread so the same offer does not repeat.

**What triggers an offer is a correction, not a count.** "You have asked this three times"
is hard to measure and easy to get wrong. "You told me I got it wrong" is unambiguous, and
the sorting engine already learns from corrections exactly this way (#24). Repetition
counting can come later if corrections prove too rare a signal.

### 4. Confirmation, and the one rule that is not negotiable

Every tool that writes confirms first. The confirmation names what will happen in one line
and waits for a yes.

- **In the app**, the confirmation is a pair of buttons in the chat stream.
- **In Telegram**, it is an inline keyboard on the message. This means handling
  `callback_query` updates, which the poll loop does not do yet: that is new work, and it is
  the right cost, because "reply yes" in a chat thread is ambiguous the moment two
  confirmations overlap.

**Deleting is always confirmed and cannot be loosened by any instruction.** Everything else
can be relaxed per case in the instructions document, once the user tires of confirming
notes. The guard lives in the capability record (`writes: true`, `destructive: true`), not
in the prompt, so no wording can talk the model out of it.

### 5. One brain, two surfaces

The in-app chat and the bot share the system prompt, the instructions, the capability
registry and the triage. The differences are only what the medium allows: Telegram has no
file preview and uses inline keyboards, the app renders citations as links and confirmations
as buttons.

This replaces today's split between `CHAT_SYSTEM_PROMPT` and
`TELEGRAM_ASSISTANT_SYSTEM_PROMPT`, which were already drifting. One prompt, one place to
change it.

### 6. What this costs

One model call per message, plus one more per tool round trip when the model calls a tool
and then speaks. So a plain question is one call as today; saving a note is two, plus the
confirmation turn. The instructions document adds its own length to every call.

The cheap-message guard already in place (a bare "ok" or an emoji is answered without a
model call) matters more now and stays.

### 7. Testing

- The capability registry is data: a unit test that every record has a description, a
  schema, and correct write and destructive flags, so a new tool cannot be added without
  declaring what it does.
- Triage is tested against a fake adapter by asserting which tool the model was offered and
  what happened when it chose each one, including `askUser`.
- Confirmation is tested as a state machine: a write tool proposes, nothing happens until a
  yes, a no discards it, and a second proposal while one is pending does not confuse them.
- The delete guard has its own test: an instruction that says "never ask before deleting"
  does not stop the confirmation.
- Instructions: saving pushes a version, rollback restores, the history is capped, and the
  body reaches the system prompt.

## Out of scope

- Reminders, tasks, calendar. They become capability records when they exist.
- Counting repetition to propose rules. Corrections first.
- Multiple instruction documents or per-topic rule sets. One document until one is proven
  not enough.

## Risks

- **Confirmation fatigue.** Every note is two exchanges by the user's explicit choice. If it
  grates, the instructions loosen it per case, and this spec should be revisited rather than
  the user quietly working around it.
- **Tool calling depends on the model.** A model that ignores tools or fabricates arguments
  degrades the whole feature. Arguments are valibot parsed and a malformed call is retried
  once, then reported honestly rather than guessed at.
- **The instructions are a prompt.** They can be argued with, ignored, or contradicted by a
  long conversation. Anything that must hold is code, which is why the delete guard is not a
  sentence in a markdown file.
