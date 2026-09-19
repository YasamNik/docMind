# Telegram assistant implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talk to the bot and get an answer about your documents, the way the app's chat
page does. Notes move behind `/note`.

**Architecture:** The telegram module gains a command parser and a conversation path that
delegates to the chat service the app already has, so retrieval, citations and history are
the existing implementation rather than a second one. Files and photos are untouched.

**Tech Stack:** the existing chat module (`chat_sessions`, `chat_messages`, `search()`,
`streamChat`), valibot, vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-telegram-assistant-design.md`

**Why this is urgent rather than next.** The user paired a real bot and reported it
"behaves just crazy, whatever i tell him it convert to text note". That is intake working
as designed and the design being wrong. Task 1 alone fixes the complaint.

## Global Constraints

- No em dashes anywhere: code, comments, tests, UI copy, commit messages.
- Pure logic in `*.models.ts`, orchestration in `*.usecases.ts`. Valibot at boundaries.
- No `*.tables.ts` change and no migration. Chat sessions and messages already exist.
- Telegram caps a message at 4096 characters. A long answer is split, never truncated.
- No test may make a network call or need a bot token.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

---

### Task 1: Plain text is a conversation

**Files:**
- Modify: `apps/server/src/modules/telegram/telegram.models.ts` and its test
- Modify: `apps/server/src/modules/telegram/telegram.usecases.ts` and its test
- Modify: `apps/server/src/modules/documents/documents.usecases.test.ts` only if it asserts
  the old behavior

**Interfaces:**
- Produces: `intentOf` returns `{ kind: "chat", text }` for plain text,
  `{ kind: "note", text }` for `/note <text>`, `{ kind: "newThread" }` for `/new`, and
  `{ kind: "web", text }` for `/web <question>`. Task 2 answers the chat and web kinds.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads plain text as something to answer, not something to file", () => {
  expect(intentOf(messageWith("where is my driver licence?"), { paired: true }).kind).toBe("chat");
});

it("reads /note as a note, and keeps the text after the command", () => {
  const intent = intentOf(messageWithCommand("/note", "buy milk"), { paired: true });
  expect(intent).toMatchObject({ kind: "note", text: "buy milk" });
});

it("accepts a command sent through Telegram's menu, with the bot username on it", () => {
  expect(intentOf(messageWithCommand("/note@docmind_bot", "buy milk"), { paired: true }).kind).toBe("note");
});

it("does not treat a slash inside a sentence as a command", () => {
  expect(intentOf(messageWith("the ratio is 3/4 note that"), { paired: true }).kind).toBe("chat");
});

it("asks for the note when /note arrives with nothing after it", () => { /* ... */ });
```

Commands are recognized from Telegram's own `bot_command` entity at offset zero, not by a
string prefix, so the menu case and the sentence case both come out right.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run telegram.models`

- [ ] **Step 3: Implement the parser, and move notes behind /note**

In the usecases, the `note` kind does exactly what plain text used to do, unchanged. The
`chat` kind is answered in Task 2; until then reply that the assistant is coming, so the
bot never silently ignores a message.

- [ ] **Step 4: Say the behavior changed, once**

The first plain text after this ships gets one extra line saying notes now need `/note`,
using the same once-only mechanism the compressed photo notice already uses. Someone who
has been texting notes for a day should not have to guess where they went.

- [ ] **Step 5: Run and commit**

```bash
git add apps/server/src
git commit -m "feat(server): the bot answers plain text instead of filing it"
```

---

### Task 2: Answering from the documents

**Files:**
- Modify: `apps/server/src/modules/telegram/telegram.usecases.ts` and its test
- Modify: `apps/server/src/modules/telegram/telegram.models.ts` (reply shaping)
- Modify: `apps/server/src/modules/chat/chat.models.ts` if the prompt needs a sibling

**Interfaces:**
- Consumes: the chat service (`createSession`, `sendMessage`, the RAG path) and Task 1's
  intents.
- Produces: an answer sent to the paired chat, split at 4096 characters.

- [ ] **Step 1: Write the failing tests**

```ts
it("answers a question about a document, and says which one it used", async () => { /* fake adapter */ });
it("answers an ordinary question without documents rather than refusing", async () => { /* ... */ });
it("keeps the thread, so a follow up understands what it refers to", async () => { /* ... */ });
it("starts fresh after /new", async () => { /* ... */ });
it("splits an answer longer than a telegram message rather than truncating it", async () => { /* ... */ });
it("says so when no chat model is configured, instead of failing silently", async () => { /* ... */ });
it("does not spend a model call on a bare ok or an emoji", async () => { /* ... */ });
```

- [ ] **Step 2: Run, watch them fail, implement**

One Telegram chat maps to one chat session, so the conversation is visible on the app's chat
page afterwards. `streamChat` is consumed to completion and sent as one message, since
Telegram has no token stream.

The assistant needs its own system prompt, separate from the app chat's document-bound one:
answer from the documents when the question is about them, cite what was used, and otherwise
talk like a person rather than refusing for lack of context. The spec's section 3 is the
wording to follow.

- [ ] **Step 3: Run everything and commit**

```bash
git add apps/server/src
git commit -m "feat(server): the bot answers from your documents"
```

---

### Task 3: /web, only when asked

**Files:**
- Modify: `apps/server/src/modules/telegram/telegram.usecases.ts` and its test
- Modify: `apps/server/src/modules/ai/` adapter, to pass web search through for one request

- [ ] **Step 1: Write the failing tests**

```ts
it("attaches web search for a /web question, and not for the next plain one", async () => { /* ... */ });
it("says plainly that /web needs an OpenRouter chat model, when it is not", async () => { /* ... */ });
```

- [ ] **Step 2: Implement**

OpenRouter attaches live web search to a request; that is the mechanism, not a second search
provider or a scraper. It is never inferred and never sticky. If the chat slot is not on
OpenRouter, `/web` says so rather than quietly answering without the web.

- [ ] **Step 3: Run and commit**

```bash
git add apps/server/src
git commit -m "feat(server): answer with the web when asked for it"
```

---

## Self-review

**Spec coverage.** Spec section 1 is Task 1, sections 2 and 3 are Task 2, section 4 is Task
3, section 5 is Task 1's note path. Section 6's cheap-message guard is in Task 2's test
list.

**What this deliberately does not do.** Reminders, the digest and the calendar are not here.
Voice notes are not here. The spec says why.

**The behavior change.** Task 1 reverses what shipped this morning, and the intake spec's
sentence about plain text becoming a note is updated with it, so two documents do not
disagree about what the product does.
