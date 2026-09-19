# The Telegram assistant

Date: 2026-09-19
Feature list item: #19 (Smart Telegram bot), the conversation half. Reminders, the daily
digest and calendar are named in #19 and #20 and are deliberately not here: they need a
scheduler and a tasks table, and they are worth their own spec.

## Why

Intake made the bot a way to put things in. The user asked for the other half, in their
words: "a friend, secretary, assistant that knows your docs, and can talk with them", with
web access. That is a chat surface in Telegram over the RAG that already exists in the app,
plus the ability to hold an ordinary conversation when no document is involved.

## What the user decided

Asked on 2026-09-19:

- **Plain text is talking.** Saving a note becomes `/note buy milk`. This reverses what
  intake shipped three hours ago, where any text became a note document, and the reversal
  is the point: a thing in your chat list that answers when you talk to it is a friend, and
  a thing that silently files your sentences is a filing cabinet.
- **The web is used only when asked**, with `/web`. Answers stay grounded in the user's own
  documents by default and the search surcharge is never paid by accident.

## Design

### 1. What a message means now

| Message | Meaning |
|---------|---------|
| plain text | a turn in the conversation |
| `/note <text>` | save a note document, the old plain-text behavior |
| `/web <question>` | a question answered with live web search attached |
| `/new` | start a fresh conversation, forgetting the thread so far |
| a file, photo or link | unchanged: intake, exactly as today |
| the pairing code, while unpaired | unchanged |

Commands are recognized by Telegram's own `bot_command` entity at offset zero, not by a
string prefix, so `/note` inside a sentence is text and a command typed through Telegram's
menu works.

**This changes shipped behavior.** The intake spec says plain text becomes a note. That
sentence is now wrong and both the spec and its tests have to change with this work, rather
than leaving two documents disagreeing about what the product does.

### 2. The conversation is the app's chat, with a different front door

The app already has chat over documents: `chat_sessions`, `chat_messages`, retrieval
through `search()`, and `streamChat` on both adapters. The assistant reuses all of it
rather than growing a second implementation that would drift.

One Telegram chat maps to one active chat session. `/new` closes it and starts another. The
session is an ordinary chat session, so a conversation held on the phone is visible in the
app's chat page afterwards, which is the behavior a person expects from the same assistant
in two places.

**Streaming does not apply.** Telegram has no token stream. The reply is assembled and sent
once, split at 4096 characters on a paragraph boundary where possible, because that is
Telegram's message limit and a truncated answer is worse than two messages.

### 3. A different prompt from the app's chat

The in-app chat prompt is document-bound: it answers from context and says it does not have
enough information otherwise. That is right for a search tool and wrong for something you
say good morning to.

The assistant gets its own prompt: answer from the user's documents when the question is
about them, cite what it used, and otherwise just talk like a person who happens to have
access to a filing cabinet. It says when it is answering from documents, from the web, or
from neither, because a confident answer with no source is the failure mode that matters
here.

Retrieval still runs on every turn, because the assistant cannot know in advance whether
"what did I pay for the boiler" is about a document. A turn with no useful hits simply has
no context block and the prompt handles that case as conversation rather than as failure.

### 4. Web access, only when asked

`/web <question>` routes the turn through OpenRouter's live web search rather than a
separate search provider: no second API key, no scraper, and the citations come back with
the answer. Mechanically that is the chat model with web search attached for that one
request, which OpenRouter bills as a surcharge per request.

Two guards, because this is the one path that costs more than the others:

- Only `/web` enables it. Never inferred, never sticky: the next plain message is a normal
  turn again.
- If the chat model's provider is not OpenRouter, `/web` says so plainly rather than
  silently answering without the web. Nothing is worse than a feature that quietly does not
  happen.

### 5. Notes keep working, explicitly

`/note <text>` does exactly what plain text did: a `text/plain` document, `source:
'telegram'`, titled by the summary model, sorted like everything else, and reported by the
existing second reply once it finishes. The code moves, the behavior does not.

`/note` with no text replies asking for the note rather than creating an empty document.

### 6. What it costs, and the guard on that

Every plain message now triggers retrieval plus a chat completion. Intake was one model call
per document; conversation is one per message, and an idle chat costs nothing. This is
worth stating because the failure mode is a bot that answers a stray "ok" with a paid
completion. Messages that are only punctuation or a single emoji are answered locally
without a model call.

### 7. Settings

None new. The assistant uses the chat model slot already configured in the AI settings, and
the existing pairing. If no chat model is configured, a conversational message replies
saying so and pointing at the settings page, the same way the sorting engine already does.

### 8. Testing

- Command parsing is pure and unit tested: `/note`, `/web`, `/new`, plain text, a command
  with no argument, a slash inside a sentence, and a command sent through Telegram's menu
  with a bot username suffix (`/note@docmind_bot`).
- The conversation path is tested against a fake AI adapter: a question with a matching
  document is answered with that document cited, a question with no match is answered as
  conversation, `/new` starts a session that does not see the previous turn, and a long
  answer is split across messages rather than truncated.
- `/web` is tested for routing and for the not-OpenRouter refusal, with no network call.
- The intake tests that assert plain text becomes a note are rewritten to assert `/note`
  does, and one test asserts plain text no longer creates a document.

## Out of scope

- Reminders, tasks, the daily digest, and anything scheduled. They need a scheduler and a
  tasks table, and #21 and #22 describe them properly.
- Calendar (#20), which is the next spec and the only one of these that writes to something
  outside DocMind.
- Voice notes (#17), which need the transcription slot.
- Answering in any chat other than the paired one. Unchanged from intake.

## Risks

- **The behavior change is the risk.** Someone used to texting notes to the bot will text a
  note and get an answer instead. The first time plain text arrives after this ships, the
  bot mentions once that notes now need `/note`, the same way it mentions photo compression
  once.
- **Cost per message.** Covered in section 6, but worth watching in real use: if an idle
  chat turns out to cost more than expected, the next lever is a cheaper model slot for
  conversation than for sorting.
- **A conversation is not a document.** Nothing said in chat is stored as a document or
  searchable later, only as chat history. That is probably right, and it is worth revisiting
  once notes with sections (#16) exist.
