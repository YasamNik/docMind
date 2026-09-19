# The assistant's instructions document implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One markdown document the user writes in Settings, appended to the assistant's
system prompt on every message, versioned on every save, and refused above 8000
characters by code rather than by a polite sentence.

**Architecture:** The document is two settings rows in the assistant module: the body and
its history. Both are `internal`, so the generic settings API cannot write them and the
only writer is the assistant module's own usecases, which enforce the cap and push a
version in the same call. The body is loaded once per turn into `ToolContext` and reaches
every model call the turn makes, wrapped in a section that states the precedence. A new
Settings tab reads and writes it through three routes of its own.

**Tech Stack:** the settings module (`defineSetting`, `setInternal`, key value rows), the
assistant module from plan 2 (`buildAssistantPrompt`, the registry, `runTurn`), valibot,
vitest, React with TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md`, sections 3,
4 and 5. This is plan 4 of five. Plan 2 (the capability registry and triage) shipped in
239359e, df1173b, ec2e776 and d3e2f68.

## What earlier plans already gave us, so this plan does not re-argue it

- `buildAssistantPrompt({ basePrompt, tools, writesWithheld })` in `assistant.models.ts`
  builds the tool-calling turn's system prompt from the registry's own records. Nothing in
  it names a tool, so a new record widens the prompt by joining the registry.
- `createAssistantService({ ..., allowWritingTools = false })` filters the offered tool set
  with `capabilities.filter((c) => !c.writes || allowWritingTools)`. That filter is the
  code gate a prompt cannot argue with, and this plan relies on it rather than adding a
  second one.
- `ToolContext` already carries `userId`, `sessionId`, `surface`, `userMessage`, the three
  services and `startNewThread`. Adding a field is a typed change the handlers pick up.
- Document text never reaches the call that can emit a tool call (plan 2, Decision 2).
  Retrieval happens inside `answerFromDocuments`'s own handler.
- The settings service caches a user's rows in memory and drops the cache on every write,
  so reading a setting per turn is a map lookup after the first read, not a query.

## Global Constraints

- **No schema change, no migration, no `*.tables.ts` touched.** Settings are key and value
  rows, so a new key and a JSON array in one value need nothing from the database. If any
  step appears to need a table or a column, stop and raise it with the user rather than
  writing it.
- **Only the user writes this document.** The two writers are the Settings route, behind
  the same auth every `/api` route uses, and `proposeInstruction` (Task 5), which is a
  writing tool and therefore shows the exact line and waits for a yes. No document text,
  no email body, no Telegram message and no model output reaches the document without the
  user reading the exact text first.
- **The cap is not advice.** 8000 characters, refused on save. The document reaches the
  prompt on every single message, so an unbounded document is unbounded cost on every
  message. `MAX_CONTEXT_CHARS` (12000) bounds the retrieved chunk block only and has
  nothing to do with this.
- **An instruction is a prompt and a prompt can be argued with.** See Decision 8 for the
  list of what this document can and cannot change. Nothing in it may become the only
  thing standing between the assistant and a write or a delete.
- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Module file roles: pure logic in `*.models.ts`, orchestration in `*.usecases.ts`, Hono
  only in `*.routes.ts`, valibot at every boundary. No Drizzle in this plan at all: the
  settings service is the only storage path.
- No test may make a network call or need a model key.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

## Decisions

**1. The document lives in the assistant module, and the keys are `assistant.instructions`
and `assistant.instructionsHistory`.** The spec calls the key `chat.instructions`. That
name is changed here, deliberately, and the spec is corrected in Task 6.

Every setting key in the registry today is prefixed with the module that defines it:
`storage.`, `extraction.`, `ai.`, `search.`, `telegram.`, `email.`, and
`assistant.toolsUnsupportedNoticeFor` from plan 2. A `chat.` key defined in
`assistant.settings.ts` would be the first key whose prefix points at a module that never
reads it. The chat module owns sessions, messages and retrieval; it never sees this
document. The assistant module owns the prompt builder, the registry and the turn runner,
which are the three things that consume it, and the document governs Telegram as much as
the app's chat page, so naming it after the chat page would be wrong twice.

Renaming costs nothing now and costs a data move later: no row with either key exists
anywhere yet, and once the user has saved a document, a rename means reading one key and
writing another on startup. Decide it while it is free.

**2. Both keys are `internal`, so `PUT /api/settings` cannot write them.** A write through
the generic settings API would change the body without pushing a version, which silently
defeats the feature this plan exists to build, and it would skip the cap. `internal: true`
already means exactly "written by server modules only, never through the settings API",
and `set()` rejects it with `settings.internal_only` and a 403. The assistant's own routes
are the only door, and they go through `saveInstructions`, which caps and versions in one
call. A route test asserts the 403, because that rejection is what keeps the history
honest.

The cost is that `GET /api/settings` does not list the document, so the Settings tab reads
it from `GET /api/assistant/instructions` instead. That endpoint is needed anyway for the
history and the caps, so nothing is lost.

**3. The cap is enforced in the usecase through a model function, not in the setting's
valibot schema.** `resolveRaw` in `settings.usecases.ts` parses a stored value against the
definition's schema on every read. A `v.maxLength(8000)` there would therefore apply on
read as well as on write: lowering the cap later, or a body that arrives by any other
route, would make the stored document unreadable and break every single turn rather than
one save. The schema stays `v.string()`.

The enforcement is `assertInstructionsWithinCap(body)` in `assistant.models.ts`, throwing
`assistant.instructions_too_long` with a sentence naming the size and the limit, called by
`saveInstructions` before anything is written. It therefore covers the HTTP path and
`proposeInstruction`'s non-HTTP path with one message in one place. The route still parses
its body with valibot, for shape, which is the boundary rule; the cap is a domain rule and
lives with the domain.

**4. History is one JSON array in one settings value, newest first, and the twenty-first
push drops the oldest permanently.** The value is
`Array<{ body: string; replacedAt: string }>`, default `[]`.

`replacedAt`, not `savedAt`: the timestamp we can record honestly is the moment the body
stopped being the live one. Knowing when it started being live would need a third key.
The editor labels an entry "In use until 19 Sep, 14:02", which is true.

On save: if the new body is identical to the stored body, nothing is written at all, so
pressing Save twice cannot push a duplicate and evict a real version. Otherwise the
previous body is unshifted with `replacedAt = now`, and the array is sliced to twenty. The
twenty-first push drops the oldest with no warning beyond the editor's line "The last 20
versions are kept." Worst case size is twenty bodies of 8000 characters, about 160 KB, in
one text row read into a per user memory cache. That is fine for one row read once per
process and named here so nobody discovers it later.

**5. Restore is a save, not a rewind.** Restoring a version writes that body through the
same `saveInstructions` path, so the body it replaces is itself pushed onto the history.
Nothing is lost by restoring, and a restore can be undone by restoring again. A version is
identified by its `replacedAt`, not by its index, so the list moving under a save cannot
restore the wrong one; an unknown one is `assistant.instruction_version_not_found` with a
404.

Resetting to the shipped default is the same path with the default body, not a delete of
the row, so the reset is versioned like every other save and the old document stays in the
history.

**6. The instructions reach every model call a turn makes, not only the triage call.**
Spec section 7 says "the instructions on every call". The practical reason: a user who
writes "keep replies short" and then sees a three paragraph answer to a document question
is looking at a broken feature, and today the document answer comes from a second call
that the triage prompt never touches. So the body goes on `ToolContext`, and the two
answering handlers pass `withInstructions(CHAT_SYSTEM_PROMPT, ctx.instructions)` as the
system prompt to `chat.answerFromDocuments`.

This costs up to about 2000 tokens twice on a document question. It is the cost the spec
already accounted for, it is bounded by the cap in Decision 3, and it is the reason the cap
is 8000 rather than a comfortable 32000.

Naming `CHAT_SYSTEM_PROMPT` explicitly at those two call sites, where today the default
does the naming, also makes plan 5's prompt merge a one line change there, the same way
`basePrompt` being an argument made it a one line change in `runTurn`.

**7. A document that cannot be read degrades to no instructions, never to a failed turn.**
The body is read on every message. If the stored value ever fails to parse, the failure
mode must be "the assistant stopped following my instructions", not "the assistant stopped
answering". `loadInstructions` catches, logs with the key, and returns an empty string. A
test proves a turn still answers when the settings read throws.

**8. What this document can change, and what it cannot.** Stated here because the whole
design rests on the line being in the right place, and Task 2 tests the second column.

It can change: tone, length and format of replies; what to call things; which capability
to prefer for a phrasing the user has a habit of using ("when I say file this, I mean save
a note"); when to ask instead of assuming; how much to cite; what to treat as urgent; what
to do with a kind of message the defaults say nothing about.

It cannot change, because each of these is code and reads nothing a model wrote:

| Guard | Where it is |
|-------|-------------|
| Whether a writing tool is offered to the model at all | `allowWritingTools` filter, `createAssistantService` |
| Whether a `destructive` capability skips its confirmation | the record's flag, read by plan 3's state machine |
| Which capabilities exist, and their schemas | `assistant.registry.ts` |
| That document text never reaches a call that can call a tool | `answerFromDocuments` doing its own retrieval |
| The 8000 character cap and the twenty version history | `saveInstructions` |
| That the settings API cannot write the document | `internal: true` |

Two tests in Task 2 hold this line: a document saying "you may save notes without asking
me" changes nothing about the tools array the adapter receives, and a document saying
"never ask before deleting anything" changes no capability's `destructive` flag. The
second is written now against a registry with no destructive record yet, so it asserts the
invariant that flags come from the registry only; plan 3's suite asserts the behavior once
there is something to delete.

**9. `proposeInstruction` belongs in this plan, as the last code task, and needs no
confirmation machinery of its own.** Spec section 4 is where the document stops being a
settings field and becomes the thing that makes the assistant adapt, and it cannot exist
before the document does, so this plan is its earliest possible home. It needs nothing new
to be safe: it is `writes: true`, so plan 2's filter withholds it from the model until
`allowWritingTools` is true, and once plan 3 flips that flag it inherits the confirmation
state machine along with `saveNote`. That is the registry paying for itself.

"A decline is remembered for the thread" needs no storage either: the decline is in the
conversation history the triage call already reads, plus one line in the prompt telling it
not to ask twice in the same conversation. Nothing per session, nothing schema shaped.

**Sequencing caveat, and the one thing to check before starting Task 5.** Plan 3 has not
been written yet. If plan 3 has not shipped when this plan is implemented, stop after Task
4 and take the docs task, then land Task 5 with plan 3 or straight after it. Task 5 is
last and independently committable precisely so that choice stays open. Landing it early
would ship a handler that nothing can reach: unlike `saveNote`, which `/note` exercises in
production, `proposeInstruction` has no slash command, so it would be live only in its
tests.

**10. The editor is a new Settings tab, not a generated field.** `client.md` says settings
forms are generated from the registry. That rule is about the per provider and per driver
forms it was written for. This is one prose document with a size counter, a warning
threshold, a version list, a preview and a restore, on endpoints of its own, and the
registry does not list it at all (Decision 2). A sixth tab is cheap: `SettingsPage` already
scrolls its tab list sideways below md, with a comment saying why.

**11. Restore confirms with a dialog; saving does not.** Clicking a version opens it
read only in a preview panel, and Restore inside that panel opens a confirm dialog saying
"The text you have now is kept in the history." That follows `client.md` ("every
destructive or costly action confirms first and states the consequence") without pretending
the action is worse than it is. Save needs no dialog: it is the ordinary action of the
page, and the cap refusal is what protects it.

**12. The history endpoint returns full bodies, not previews.** Twenty bodies is at most
160 KB on one local request, and returning previews would mean a second round trip to show
a version before restoring it, on a page one person opens occasionally. One request, full
bodies, and the number is named in Decision 4 rather than discovered later.

## The shipped default document, in full

This is what a new user opens the tab and reads, so it is written here rather than
described. It is markdown, it is in the user's own voice because it is their document, it
is about 1100 characters (well under the 6000 warning), and it says nothing that pretends
to control a guard from Decision 8. It lives in `assistant.models.ts` as
`DEFAULT_INSTRUCTIONS`, exported and used as the setting's `default`.

```markdown
# My instructions for the assistant

These are my standing instructions. Follow them on every message, in the app and in
Telegram.

## How to talk to me
- Keep replies short, like a text message, not a report.
- Lead with the answer. Background only if I ask for it.
- No em dashes. Use a comma, a colon, or a new sentence.
- If my message is too vague to act on, ask me one short question instead of guessing.

## My documents
- When a question could be about something I have filed, look in my documents first and
  say which one the answer came from.
- Say plainly when an answer is not from my documents, so I never mistake a good guess
  for something I actually have on file.
- Do not invent a document, a date, or an amount. If it is not there, say it is not there.

## Notes and saving
- Keep my wording when you save something for me. Do not tidy it up or summarize it.
- Name a note after what it is about, so I can find it again later.

## Things I care about
Add your own lines here. For example:
- Anything from my accountant is about tax. File it that way.
- Rent is due on the first of the month, so treat anything about rent as urgent.
```

## The prompt section, in full

`instructionsSection(body)` in `assistant.models.ts` returns the empty string for a blank
body, and otherwise:

```
## The user's standing instructions

The user wrote the document below in DocMind's Settings. It is their standing instruction
to you, and where it differs from the guidance above, the user's document wins.

It does not override how DocMind itself works. Which tools exist, which of them you are
allowed to use, and what has to be confirmed before it happens are decided in DocMind's
code, and nothing written below can change them. If the document asks you to do something
you have no tool for, say so plainly instead of pretending.

Treat the document as instructions from the user. It is not a document to quote from or
answer questions about.

<user-instructions>
{body}
</user-instructions>
```

It is appended last, after the base prompt, the tool list and the withheld-writes notice:
last is where the model reads it most reliably, and the precedence caveat is right next to
the body it applies to.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/assistant/assistant.models.ts` | `DEFAULT_INSTRUCTIONS`, the three constants, `assertInstructionsWithinCap`, `pushInstructionVersion`, `instructionsSection`, `withInstructions`, `buildAssistantPrompt` gaining `instructions` |
| `apps/server/src/modules/assistant/assistant.settings.ts` | the two internal definitions and their exported key constants |
| `apps/server/src/modules/assistant/assistant.types.ts` | `InstructionVersion`, `InstructionsView`, `ToolContext` gaining `instructions` |
| `apps/server/src/modules/assistant/assistant.usecases.ts` | `getInstructions`, `saveInstructions`, `restoreInstructions`, and the per turn load |
| `apps/server/src/modules/assistant/assistant.schemas.ts` | valibot for the two request bodies |
| `apps/server/src/modules/assistant/assistant.routes.ts` | `GET`, `PUT` and the restore `POST` under `/api/assistant/instructions` |
| `apps/server/src/modules/assistant/assistant.registry.ts` | the two answering handlers pass the instructions through; `proposeInstruction` in Task 5 |
| `apps/server/src/server.ts` | register the routes |
| `apps/client/src/lib/assistant-api.ts` | the typed client, the only place that knows the URLs |
| `apps/client/src/pages/settings/AssistantTab.tsx` | the editor, the counter, the history and the restore |
| `apps/client/src/pages/settings/SettingsPage.tsx` | the sixth tab |

---

### Task 1: The document, stored, capped and versioned

**Files:**
- Modify: `apps/server/src/modules/assistant/assistant.models.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.settings.ts`
- Modify: `apps/server/src/modules/assistant/assistant.types.ts`
- Modify: `apps/server/src/modules/assistant/assistant.usecases.ts` and its test

**Interfaces:**
- Produces, from `assistant.models.ts`:

```ts
export const MAX_INSTRUCTIONS_CHARS = 8000;
export const WARN_INSTRUCTIONS_CHARS = 6000;
export const MAX_INSTRUCTION_VERSIONS = 20;
export const DEFAULT_INSTRUCTIONS: string;

// Throws assistant.instructions_too_long, status 400, with a sentence naming both numbers.
export function assertInstructionsWithinCap(body: string): void;

// Pure. Newest first, capped, and the caller decides whether there was a change at all.
export function pushInstructionVersion({
  history, body, replacedAt,
}: { history: InstructionVersion[]; body: string; replacedAt: string }): InstructionVersion[];
```

- Produces, from `assistant.types.ts`:

```ts
export type InstructionVersion = { body: string; replacedAt: string };
export type InstructionsView = {
  body: string;
  source: SettingSource;          // "default" until the first save, then "db"
  maxChars: number;
  warnChars: number;
  history: InstructionVersion[];  // newest first
};
```

- Produces, on the assistant service:

```ts
getInstructions({ userId }): Promise<InstructionsView>
saveInstructions({ userId, body }): Promise<InstructionsView>
restoreInstructions({ userId, replacedAt }): Promise<InstructionsView>
```

- Consumes: `settingsService.get`, `settingsService.getResolved`, `settingsService.setInternal`.

**Behavior:**

- `getInstructions` resolves the body through `getResolved` so the view can say whether the
  user has ever saved, and reads the history separately, defaulting to `[]`.
- `saveInstructions` trims trailing whitespace, asserts the cap, and returns unchanged with
  no write at all when the body equals the stored one. Otherwise it writes the history
  first and the body second, both with `setInternal`, then returns the fresh view.
- `restoreInstructions` finds the version by `replacedAt`, throws
  `assistant.instruction_version_not_found` with a 404 if there is none, and otherwise
  calls `saveInstructions` with that body, so the replaced body joins the history.
- Nothing here logs the body. It is not a secret, but it is the user's private writing and
  it has no business in a log line.

**Watch out:** the history is written before the body. If the second write fails, the
history holds a duplicate of the still-current body, which is harmless. The reverse order
would lose a version on the same failure. There are no transactions to reach for here:
settings writes are two independent upserts.

- [ ] **Step 1: Write the failing model tests**

```ts
it("ships a default document with headings a person can edit", () => { /* markdown, non-empty */ });
it("ships a default well under the warning threshold", () => { /* < WARN_INSTRUCTIONS_CHARS */ });
it("accepts a document of exactly the maximum length", () => { /* 8000 passes */ });
it("refuses one character over, and says the size and the limit", () => {
  // 8001 throws assistant.instructions_too_long, and the message contains both numbers
});
it("pushes the previous body onto the front of the history", () => { /* ... */ });
it("records when each version stopped being the live one", () => { /* replacedAt */ });
it("keeps twenty versions and drops the oldest on the twenty-first", () => {
  // length stays 20, the first-ever body is gone, the newest is at index 0
});
```

- [ ] **Step 2: Write the failing usecase tests**

Against `createTestApp`, reaching the service as `t.services.assistantService`:

```ts
it("returns the shipped default before anything has been saved", async () => { /* source: "default" */ });
it("returns the saved body on the next read, and says it came from the database", async () => { /* ... */ });
it("pushes the replaced body onto the history on the second save", async () => { /* ... */ });
it("writes nothing at all when the body has not changed", async () => {
  // history length unchanged after saving the same text twice in a row
});
it("refuses a body over the cap and leaves the stored one untouched", async () => {
  // the failure path that matters: the read after the refusal returns the old body
});
it("never lets the history grow past twenty across many saves", async () => { /* 25 saves */ });
it("restores a previous version and keeps the body it replaced", async () => { /* ... */ });
it("refuses to restore a version that is not in the history", async () => {
  // assistant.instruction_version_not_found, and the live body is unchanged
});
it("resets to the shipped default as an ordinary versioned save", async () => { /* the old body is in history */ });
it("keeps the document out of the settings list", async () => {
  // listResolved does not include either key, since both are internal
});
```

- [ ] **Step 3: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run assistant`

- [ ] **Step 4: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`. Nothing reads the document
yet, so no behavior a user can see has changed.

```bash
git add apps/server/src/modules/assistant
git commit -m "feat(server): the assistant's instructions document, versioned and capped"
```

**Done when:** the assistant suite is green, both keys are registered and internal, and
`git status` shows no `*.tables.ts` file and no file under `apps/server/drizzle/` touched.

---

### Task 2: The instructions reach every call

**Files:**
- Modify: `apps/server/src/modules/assistant/assistant.models.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.types.ts`
- Modify: `apps/server/src/modules/assistant/assistant.registry.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.usecases.ts` and its test

**Interfaces:**
- Produces:

```ts
export function instructionsSection(body: string): string;      // "" for a blank body
export function withInstructions(base: string, body: string): string;

buildAssistantPrompt({ basePrompt, tools, writesWithheld, instructions }): string
```

```ts
loadInstructions(userId: string): Promise<string>   // reads INSTRUCTIONS_KEY only
```

- `ToolContext` gains `instructions: string`, the resolved body for this turn, loaded once.
- `loadInstructions` reads `assistant.instructions` and nothing else. It must never call
  `getInstructions()`, which also reads and validates the twenty entry history array that
  a turn has no use for. Decision 4's judgement that the history value is off the hot path
  depends entirely on this, so a test spies on `settingsService.get` and asserts a turn
  never touches `assistant.instructionsHistory`.

**Behavior:**

1. `buildContext` in `assistant.usecases.ts` becomes async and loads the body once per turn
   through `loadInstructions(userId)`, which catches and returns `""` on any failure and
   logs it (Decision 7). Both `runTurn` and `runCommand` build their context this way, so
   `/web` gets the instructions too.
2. `runTurn` passes the same body to `buildAssistantPrompt`, which appends
   `instructionsSection(instructions)` last, after the withheld-writes notice.
3. `answerFromDocuments` and `searchWeb` in the registry pass
   `systemPrompt: withInstructions(CHAT_SYSTEM_PROMPT, ctx.instructions)` to
   `chat.answerFromDocuments`. Naming the base explicitly is a no-op today, since it is
   that function's default, and it is what plan 5 will swap.
4. The app's own chat page is untouched. `chat.sendMessage` keeps its exact behavior, so
   the in-app chat does not gain the instructions until plan 5 puts it on `runTurn`.

**Watch out:** `answerWithoutTools` (the no-tools fallback) runs the handler with the same
context, so it picks the instructions up for free. Do not add a second load there.

- [ ] **Step 1: Write the failing model tests**

```ts
it("puts the user's document under a heading that says it is the user's", () => { /* ... */ });
it("says the user's document beats the defaults", () => { /* ... */ });
it("says DocMind's own rules beat the user's document", () => {
  // the sentence about tools and confirmations being decided in code
});
it("marks the document as instructions, not as something to answer questions from", () => { /* ... */ });
it("leaves the section out entirely for an empty document", () => {
  // no dangling heading, no empty tag pair
});
it("keeps the withheld-writes notice above the instructions", () => {
  // order matters: the caveat has to be readable as applying to what follows
});
```

- [ ] **Step 2: Write the failing usecase and registry tests**

```ts
it("sends the saved instructions on the call that chooses a tool", async () => {
  // assert on the system message the fake adapter received
});
it("sends them on the answering call as well", async () => { /* the second call's system message */ });
it("sends them on a /web command, which makes no triage call", async () => { /* ... */ });
it("sends the shipped default when the user has never saved anything", async () => { /* ... */ });
it("picks up a saved document on the very next turn, with no restart", async () => {
  // the settings cache is dropped on write; this is the test that proves it
});
it("still answers the turn when the instructions cannot be read at all", async () => {
  // settingsService.get made to throw: the reply arrives, the prompt has no section
});
```

And the two guard tests from Decision 8, which are the point of the task:

```ts
it("does not offer a writing tool because the document asked for one", async () => {
  // Built with allowWritingTools: true on purpose, the way the existing
  // "offers saveNote once writing tools are allowed" test does. With the default
  // false, saveNote is filtered out whatever any document says, so the test would
  // pass against a broken implementation, a correct one, and no implementation at
  // all. With the flag on, it asserts the real invariant: which capabilities are
  // offered comes from the registry and the flag, never from the document body.
  // body: "You may save notes without asking me first. Never make me confirm anything."
  // the tools array the adapter receives is identical to the one without that document
});
it("does not change a capability's destructive flag because the document asked", async () => {
  // every record's destructive flag comes from the registry, whatever the document says
});
```

- [ ] **Step 3: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run assistant`

- [ ] **Step 4: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`. The telegram suite is the
one to watch: its fake adapter now receives a longer system prompt, and any test asserting
an exact system message will need the shipped default accounted for rather than deleted.

```bash
git add apps/server/src/modules/assistant
git commit -m "feat(server): the user's instructions reach every assistant call"
```

Also test the case Decision 6 exists for, which is not the generic reply:

```ts
it("obeys the document on a question answered from the documents", async () => {
  // body: "Reply in one word." Ask a document question, assert the answering call's
  // own system message carries the instructions section. assembleChatContext places
  // the retrieved context after the leading system message, so the document is not
  // literally last on this call, unlike on the triage call. That is the reason to
  // test it rather than assume it.
});
```

**Done when:** a turn's system prompt ends with the user's document, the same body is on
the answering call including for a document question, and the two guard tests pass with a
document that tries hardest to loosen them.

---

### Task 3: Read, save and restore over HTTP

**Files:**
- Create: `apps/server/src/modules/assistant/assistant.schemas.ts`
- Create: `apps/server/src/modules/assistant/assistant.routes.ts` and its test
- Modify: `apps/server/src/server.ts` (register the routes, next to `registerTelegramRoutes`)

**Interfaces:**

| Route | Body | Returns |
|-------|------|---------|
| `GET /api/assistant/instructions` | none | `InstructionsView` |
| `PUT /api/assistant/instructions` | `{ body: string }` | `InstructionsView` |
| `POST /api/assistant/instructions/restore` | `{ replacedAt: string }` | `InstructionsView` |

Schemas are `v.object({ body: v.string() })` and
`v.object({ replacedAt: v.pipe(v.string(), v.minLength(1)) })`, parsed with
`parseJsonBody`. The cap is not in the schema (Decision 3), so an oversize body comes back
as `assistant.instructions_too_long` with its own sentence rather than as a generic
`validation`.

**Behavior:** three thin handlers over the three usecases, `getUserId(c)` for the user, no
Drizzle, no orchestration. Same shape as `telegram.routes.ts`.

- [ ] **Step 1: Write the failing route tests**

```ts
it("returns the shipped default, the caps and an empty history", async () => { /* ... */ });
it("saves a document and returns the new view with the old one in the history", async () => { /* ... */ });
it("refuses a document over the cap with 400 and a sentence naming the limit", async () => { /* ... */ });
it("restores a version by its timestamp", async () => { /* ... */ });
it("returns 404 for a version that is not in the history", async () => { /* ... */ });
it("rejects an unauthenticated request", async () => { /* the same guard every /api route has */ });
it("refuses to write the document through the settings API", async () => {
  // PUT /api/settings with assistant.instructions returns 403 settings.internal_only.
  // This is the regression guard for Decision 2: a save that skipped the route would
  // change the document with no version recorded.
});
it("does not list the document in GET /api/settings", async () => { /* ... */ });
```

- [ ] **Step 2: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/server exec vitest run assistant.routes`

- [ ] **Step 3: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`

```bash
git add apps/server/src
git commit -m "feat(server): read, save and restore the instructions document"
```

**Done when:** the three routes work against `createTestApp`, and the settings API still
refuses both keys.

---

### Task 4: The Settings editor

**Files:**
- Create: `apps/client/src/lib/assistant-api.ts`
- Create: `apps/client/src/pages/settings/AssistantTab.tsx` and its test
- Modify: `apps/client/src/pages/settings/SettingsPage.tsx` and its test

**Interfaces:**

```ts
export type InstructionVersion = { body: string; replacedAt: string };
export type InstructionsView = { body: string; source: string; maxChars: number; warnChars: number; history: InstructionVersion[] };

export const assistantApi = {
  instructions(): Promise<InstructionsView>,
  saveInstructions(body: string): Promise<InstructionsView>,
  restoreInstructions(replacedAt: string): Promise<InstructionsView>,
};
```

**Behavior:**

- One `Card` titled "Assistant", a `textarea` holding the document, monospace, tall enough
  to write in. There is no `Textarea` component in `components/ui` today; follow the plain
  styled `textarea` in `CategoriesPage.tsx` rather than adding one for a single use.
- Under it, on one line: `1,204 / 8,000 characters`. Muted below the warning threshold,
  warning-coloured from `warnChars`, destructive-coloured above `maxChars` with the words
  "Too long to save. Shorten it by 41 characters."
- Save is disabled when the text is unchanged and when it is over the cap. The server is
  still the enforcement: a save that somehow gets through shows the server's own message in
  a toast.
- A short paragraph above the editor, in plain words: this document goes to the assistant
  with every message, in the app and in Telegram, so keep it short; it changes how the
  assistant talks and what it assumes, and it cannot give the assistant new abilities or
  remove a confirmation.
- "Reset to the shipped default" saves the default body, after a confirm dialog, and the
  current text lands in the history like any other save.
- A "Previous versions" list, newest first, each row "In use until 19 Sep, 14:02" with a
  character count. Clicking one opens a read only preview. Restore inside the preview opens
  a confirm dialog saying the current text is kept in the history.
- TanStack Query throughout, one query key `["assistant-instructions"]`, invalidated on
  every mutation. Local state holds only the draft text.
- The tab joins `SettingsPage` after Email and before Data, so the order reads AI,
  Storage, Telegram, Email, Assistant, Data.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the saved document in the editor", async () => { /* ... */ });
it("counts the characters against the limit", async () => { /* ... */ });
it("warns once the document passes the warning threshold", async () => { /* ... */ });
it("refuses to save a document over the limit, and says how much to cut", async () => {
  // Save disabled, and the api client is never called
});
it("keeps Save disabled until the text actually changes", async () => { /* ... */ });
it("saves the edited document and tells the user", async () => { /* ... */ });
it("shows the server's own message when a save is refused", async () => {
  // the failure path: the mutation rejects with the cap error, the toast carries its text
});
it("lists previous versions newest first, with when each stopped being used", async () => { /* ... */ });
it("previews a version without replacing what is in the editor", async () => { /* ... */ });
it("asks before restoring, and says the current text is kept", async () => { /* ... */ });
it("says the document cannot give the assistant new abilities", async () => {
  // the explanatory copy is load bearing here, so it is asserted like any other behavior
});
```

`SettingsPage.test.tsx` gains one assertion that the Assistant tab renders, and its
`@/lib/assistant-api` mock.

- [ ] **Step 2: Run, watch them fail, implement**

Run: `pnpm --filter @docmind/client exec vitest run settings`

- [ ] **Step 3: Run everything and commit**

Run: `pnpm --filter @docmind/client test` and `pnpm typecheck`

```bash
git add apps/client/src
git commit -m "feat(client): an Assistant tab for the instructions document"
```

**Done when:** the document can be read, edited, saved, over-filled and refused, and rolled
back, from the Settings page, with no server restart anywhere in that loop.

---

### Task 5: The assistant offers to write a rule down

**Only start this task once plan 3 has shipped `chat_sessions.pending_tool_call` and
`allowWritingTools` is true.** See Decision 9. If plan 3 is not in, skip to Task 6 and land
this with plan 3 instead.

**Files:**
- Modify: `apps/server/src/modules/assistant/assistant.registry.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.models.ts` and its test
- Modify: `apps/server/src/modules/assistant/assistant.usecases.ts` (the context the handler
  needs to save, nothing else)

**Interfaces:** one more record, nothing else changes:

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
  handler: appends the line to the document through saveInstructions,
}
```

**Behavior:**

- The handler appends `line` as a new bullet under a "## Things I care about" heading,
  creating the heading if the document has none, and saves through `saveInstructions`, so
  the append is capped and versioned exactly like a save from Settings.
- A document already at the cap makes the append fail with the same
  `assistant.instructions_too_long`, which plan 2's `runHandler` turns into a plain reply
  ("Your instructions are already at the 8000 character limit, so I could not add that.
  Trim them in Settings and ask me again."). Nothing is silently dropped.
- The confirmation is plan 3's, unchanged: the user sees the exact line before it is
  written, because the pending proposal holds the parsed arguments and the proposal text is
  built from them.
- The prompt gains one line about when to offer: after a correction, once per conversation,
  never on its own initiative. The decline lives in the conversation history, not in a
  column.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds the line to the document, under the user's own heading", async () => { /* ... */ });
it("creates the heading when the document does not have one", async () => { /* ... */ });
it("versions the append, so it can be rolled back from Settings", async () => { /* ... */ });
it("says plainly when the document is too full to add anything", async () => {
  // the failure path: nothing is written, and the reply says what to do
});
it("is withheld from the model while writing tools are withheld", async () => { /* allowWritingTools false */ });
it("waits for the user's yes before writing anything", async () => {
  // plan 3's state machine: the proposal is pending, the document is unchanged
});
it("writes nothing at all when the user says no", async () => { /* ... */ });
```

- [ ] **Step 2: Run, watch them fail, implement**

- [ ] **Step 3: Run everything and commit**

```bash
git add apps/server/src/modules/assistant
git commit -m "feat(server): the assistant can offer to write a rule down"
```

**Done when:** a correction leads to one offer, a yes writes one line and a version, and a
no writes nothing.

---

### Task 6: Say what the instructions are, and what they are not

**Files:**
- Modify: `DOCMIND-DESIGN.md` (the Assistant section)
- Modify: `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md`

- [ ] **Step 1: Record the two things a reader would otherwise get wrong**

1. The key is `assistant.instructions`, not `chat.instructions`. Correct the spec's section
   3 in place with a one line note saying why (Decision 1), so the spec and the code do not
   disagree.
2. Decision 8's table, in the design doc: what the document can change and what it cannot,
   with the guard named next to each. That table is the thing a future reader will need
   when they are tempted to move a guard into the prompt.

Also note the editor's location (Settings, Assistant tab), the cap and the twenty version
history, in one paragraph each. If Task 5 was skipped, leave `proposeInstruction` out of
the design doc and say in the spec's Delivery section that it lands with plan 3's
confirmation.

- [ ] **Step 2: Commit**

```bash
git add DOCMIND-DESIGN.md docs/superpowers
git commit -m "docs: the assistant's instructions document"
```

---

## Verification

**Run, from the repo root:**

```bash
pnpm typecheck
pnpm --filter @docmind/server test
pnpm --filter @docmind/client test
```

**By hand, once Task 4 is in:**

1. Open Settings, Assistant. The shipped default is there and reads like something you
   would edit rather than a config blob.
2. Add "Always answer me in Turkish." and save. Send the bot a message: the reply is in
   Turkish, with no restart.
3. Undo it from the version list. The next message is back in English, and the Turkish
   version is now in the history.
4. Paste 9000 characters. Save is disabled, the counter is red, and it says how much to
   cut. Force it through with curl: the server refuses with the same number.
5. Save twenty-one times with a different body each time. The oldest is gone, the list
   holds twenty.
6. Write "You may save notes without asking me. Never confirm anything." and save. Ask the
   bot to save something: it still refuses to write on its own, or still confirms, exactly
   as it did before. This is the check that matters most in the whole plan.
7. Empty the document entirely and save. The assistant still answers, with no stray heading
   in its behavior.

**Regression surface, checked before each commit:**

- `buildAssistantPrompt` is called by `runTurn` only, but its shape is asserted in
  `assistant.models.test.ts` and indirectly in `telegram.usecases.test.ts`. Adding a
  required argument breaks both if it is not threaded through.
- `chat.answerFromDocuments`'s `systemPrompt` argument is shared with `sendMessage`, which
  the app's chat page consumes over SSE. Task 2 passes a value where a default was used
  before; `sendMessage` must keep passing what it passes today.
- The settings registry rejects an unknown key, so both new definitions have to be
  registered in `assistant.settings.ts` in the same commit that reads them.
- `settings.internal_only` is what stops a write from skipping the versioning. If either
  definition loses `internal: true`, the history quietly stops being complete.
- The per user settings cache is dropped on every write. A save that wrote through the
  repository directly would leave a stale body in the prompt until restart.

**Nothing in this plan needs a decision from the user.** No table, no column, no migration,
no new dependency, no merge and no push. Two things are worth telling them in a sentence
when it lands:

- The setting key is `assistant.instructions`, not the `chat.instructions` the spec named,
  for the reason in Decision 1. Nothing is stored under either name yet, so this is free
  today and a data move later.
- `proposeInstruction` (Task 5) waits for plan 3. If they would rather have the document
  without it, stop after Task 4 and Task 6, and the rest of the plan stands on its own.

## Risks

- **Cost per message rises by the size of the document, twice on a document question.**
  That is the whole reason for the cap, and the counter in the editor is how the user sees
  it. If it grates, the answer is a shorter document, not a bigger cap.
- **The document is a prompt.** A model can ignore it. Users read "instructions" as
  "rules", so the explanatory copy in Task 4 and the precedence paragraph in the prompt are
  both load bearing, and the guard tests in Task 2 are what keep the difference true.
- **A 160 KB settings row.** Twenty full sized versions in one value. Read once per
  process into the cache, never sent anywhere except the editor. Named in Decision 4 so it
  is a known number and not a surprise.
- **The default document is opinionated.** It tells the assistant to keep replies short and
  to avoid em dashes, which is this user's taste rather than a universal one. It is the
  first thing they can edit, which is the point.

## Self-review

**Spec coverage.** Section 3 is Tasks 1 to 4: storage and the default in Task 1, the prompt
and the precedence in Task 2, versioning across both, the cap in Task 1 and enforced again
at the boundary in Task 3, the editor in Task 4. Section 4 is Task 5, with `askUser`
already shipped in plan 2 and only the remembering half left. Section 5's precedence is
Decision 8, tested in Task 2. Section 8's instructions tests are distributed across Tasks
1, 2 and 3: a save pushes a version, a rollback restores, the history is capped, the body
reaches the prompt, and 8001 characters is refused in three places.

**What this plan deliberately does not do.** It does not touch the app's chat page, which
still runs `chat.sendMessage` with `CHAT_SYSTEM_PROMPT` and no instructions until plan 5.
It does not merge the two system prompts. It does not add a `Textarea` component. It does
not let the instructions carry per document or per tag rules, which is the sorting engine's
job and would be a different feature wearing this one's name.

**The risk worth restating.** The moment this ships, every behavior question has two
plausible homes: the prompt and the code. The temptation on the next bug will be to add a
line to the default document instead of writing the guard. Decision 8's table exists to be
quoted at that moment.
