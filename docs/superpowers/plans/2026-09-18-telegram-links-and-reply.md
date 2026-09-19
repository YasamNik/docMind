# Telegram links and the second reply

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the bot a link and get the page saved as a document. Then have the bot come
back a few seconds later and tell you what it filed, under what category, with what tags.

**Architecture:** A guarded fetcher turns a URL into readable text, which goes through the
same upload path everything else uses. A second loop watches documents the bot created and
reports each one once its summary and rules both finish, because jobs fan out rather than
chaining and there is no completion hook to hang this on.

**Tech Stack:** undici (already present through Node) for a connection-pinned fetch,
`@mozilla/readability` with `linkedom` for article extraction, vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-telegram-intake-design.md`, sections 6 and 7.

**This is plans 2 and 3 from the spec, in one file.** They were split so the
security-sensitive link fetch would not stall the rest; the rest has landed, so the only
reason left to keep them apart is review focus, and the tasks below stay separable. Task 1
and 2 are links. Task 3 is the second reply.

**Already landed (plan 1):** the `source` column, the Bot API client, `intentOf` returning
a `link` kind that currently answers `linkNotSupportedReply()`, the polling loop, pairing,
the settings page and routes.

## Global Constraints

- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Pure logic in `*.models.ts`, orchestration in `*.usecases.ts`, Drizzle only in a
  repository. Every boundary parsed with valibot.
- No `*.tables.ts` change and no migration: `source` already exists and the rest is
  settings. If a task seems to need one, stop and raise it.
- No test may make a network call. The fetcher takes its dispatcher and its DNS lookup as
  dependencies so tests supply fakes.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/telegram/link-fetch.models.ts` | is this address allowed, pure |
| `apps/server/src/modules/telegram/link-fetch.ts` | the guarded fetch and readable text |
| `apps/server/src/modules/telegram/telegram.usecases.ts` | link intake, then the notifier |
| `apps/server/src/modules/documents/documents.repository.ts` | find bot documents that finished |

---

### Task 1: Which addresses may be fetched

**Files:**
- Create: `apps/server/src/modules/telegram/link-fetch.models.ts`
- Create: `apps/server/src/modules/telegram/link-fetch.models.test.ts`

**Interfaces:**
- Produces: `isPublicAddress(ip: string): boolean` and
  `assertFetchableUrl(raw: string): URL`, which throws an `AppError` with code
  `telegram.link_refused` for a non-http scheme or an unparseable URL. Task 2 uses both.

**Why this is its own task.** This is the only place in DocMind where a string from outside
causes an outbound request. The rules belong in a pure function with its own tests, not
inlined in a fetch call where they are read once and never again.

- [ ] **Step 1: Write the failing tests**

```ts
describe("isPublicAddress", () => {
  it("refuses loopback, private, link local and unique local addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
                      "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(ip)).toBe(true);
    }
  });
});

describe("assertFetchableUrl", () => {
  it("accepts http and https", () => {
    expect(assertFetchableUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("refuses every other scheme", () => {
    for (const raw of ["file:///etc/passwd", "ftp://example.com", "data:text/html,hi", "javascript:alert(1)"]) {
      expect(() => assertFetchableUrl(raw)).toThrow(/refus/i);
    }
  });
});
```

Note `169.254.169.254` in the list: that is the cloud metadata address, the single most
valuable target for this class of bug, and `::ffff:127.0.0.1` is loopback wearing an IPv6
coat.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run link-fetch.models`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Pure, no IO, no DNS. Parse with `new URL` inside a try. Check IPv4 ranges numerically
rather than by string prefix, so `10.0.0.5` and `100.64.0.1` are told apart correctly.
Handle IPv4-mapped IPv6 by unwrapping the `::ffff:` prefix before deciding.

- [ ] **Step 4: Run, then commit**

```bash
git add apps/server/src/modules/telegram
git commit -m "feat(server): decide which addresses a link may point at"
```

---

### Task 2: Fetching a link and reading it

**Files:**
- Create: `apps/server/src/modules/telegram/link-fetch.ts`
- Create: `apps/server/src/modules/telegram/link-fetch.test.ts`
- Modify: `apps/server/src/modules/telegram/telegram.usecases.ts` (the link intent)
- Modify: `apps/server/src/modules/telegram/telegram.usecases.test.ts`
- Modify: `apps/server/package.json` (`@mozilla/readability`, `linkedom`)

**Interfaces:**
- Consumes: Task 1's guards.
- Produces: `fetchReadablePage({ url, dispatcher?, lookup? }): Promise<{ title, text, finalUrl }>`,
  throwing `telegram.link_refused` for a blocked address, scheme, size, or content type.

**The mechanism that matters.** Resolving the hostname, checking the address, then calling
`fetch(url)` resolves DNS a second time at connect, so an attacker controlling the DNS
answer can return a public address to the check and a private one to the connection. The
fix is to resolve once and pin the socket to the address that was checked, by passing a
custom `lookup` into an undici `Agent`'s `connect` options. Take both the dispatcher and
the lookup as optional arguments so tests can supply fakes without a network.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter @docmind/server add @mozilla/readability linkedom
```

- [ ] **Step 2: Write the failing tests**

```ts
it("returns the readable text and the title of an article", async () => { /* fake dispatcher serving HTML */ });

it("refuses a host that resolves to a private address", async () => {
  const lookup = (_host, _opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
  await expect(fetchReadablePage({ url: "https://localhost.attacker.test/", lookup, dispatcher })).rejects.toThrow(/refus/i);
});

it("re-checks every redirect hop, so a public page cannot bounce inward", async () => { /* 302 to http://169.254.169.254/ */ });

it("gives up after three redirects", async () => { /* ... */ });

it("refuses a response that is not html or plain text", async () => { /* image/png */ });

it("refuses a response past the size cap without reading it all", async () => { /* ... */ });

it("pins the connection to the address it checked", async () => {
  // The lookup is called once; assert the dispatcher received that same address.
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run link-fetch`

- [ ] **Step 4: Implement the fetcher**

Redirects are followed manually (`redirect: "manual"`), at most three, each hop re-run
through `assertFetchableUrl` and the resolved-address check, because following
automatically would skip the guard on every hop after the first. Cap the body at 10 MB
while reading, not by trusting `content-length`, and time out at 20 seconds.

Readability needs a DOM: parse with `linkedom`, run `Readability`, fall back to the page's
text content when Readability finds no article, since a bank statement page is not an
article and still has text worth keeping.

- [ ] **Step 5: Wire it into the loop**

Replace `linkNotSupportedReply()` with: fetch, then upload the extracted text as a
`text/plain` document named from the page title, with `source: "telegram"`. Keep the source
URL in the document's text as a first line so search and chat can cite where it came from.
A refusal replies with the plain reason.

- [ ] **Step 6: Run and commit**

Run: `pnpm --filter @docmind/server exec vitest run telegram link-fetch` then the full suite.

```bash
git add apps/server
git commit -m "feat(server): save a link as a document, safely"
```

---

### Task 3: The second reply

**Files:**
- Modify: `apps/server/src/modules/documents/documents.repository.ts`
- Modify: `apps/server/src/modules/telegram/telegram.usecases.ts`
- Modify: `apps/server/src/modules/telegram/telegram.usecases.test.ts`

**Interfaces:**
- Consumes: `telegram.lastReportedAt`, already registered and unused.
- Produces: `documentsRepository.listFinishedSince({ userId, source, since })`, returning
  documents whose `summaryStatus` and `ruleStatus` are both terminal, created after
  `since`, oldest first.

**Why a watcher.** Extraction enqueues rules, embedding and summarize as three independent
jobs and the runner has no completion hook, so there is no end of a chain to notify from.
The telegram module instead asks, each cycle, which of its own documents have finished.
`embeddingStatus` is deliberately not part of the condition: it affects search, not
anything the reply says.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports a document once both the summary and the rules have finished", async () => {
  // upload with source telegram, drive summaryStatus and ruleStatus to done,
  // runOnce(), expect one message naming the title, the category and the tags
});

it("does not report the same document twice", async () => { /* two cycles, one message */ });

it("says nothing about a document uploaded in the browser", async () => { /* source upload */ });

it("waits while the summary is still running", async () => { /* summary pending, rules done */ });

it("still reports a document whose sorting failed, naming the stage", async () => { /* ruleStatus failed */ });
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run telegram.usecases`

- [ ] **Step 3: Add the query**

In the documents repository, filtered on `userId`, `source`, both status columns being in
`("done", "failed")`, and `createdAt > since`, ordered oldest first, limited to a
reasonable batch.

- [ ] **Step 4: Add the notifier to the cycle**

After handling updates, ask for finished documents since `telegram.lastReportedAt`, send one
message each naming title, category and tags with a link to the document, and advance
`lastReportedAt` to the newest reported document's `createdAt`. On a first ever run with no
stored value, start from now rather than announcing the entire library.

- [ ] **Step 5: Run everything and commit**

Run: `pnpm --filter @docmind/server test` and `pnpm typecheck`

```bash
git add apps/server/src
git commit -m "feat(server): tell the sender what the bot filed"
```

---

## Self-review

**Spec coverage.** Section 6 is Tasks 1 and 2, section 7 is Task 3. The spec's "not
reported yet" tracking is simplified: a single `lastReportedAt` watermark ordered by
creation replaces the in-memory set, because a watermark survives a restart and the set did
not, and documents are reported in creation order anyway.

**Decisions made here.** Redirects are followed manually so the guard runs on every hop.
Readability falls back to raw text content, since many useful pages are not articles. The
source URL is kept as the document's first line rather than in a new column, because that
needs no migration and makes the URL searchable.

**Type consistency.** `telegram.link_refused`, `fetchReadablePage`, `listFinishedSince` and
`lastReportedAt` are spelled identically everywhere they appear.
