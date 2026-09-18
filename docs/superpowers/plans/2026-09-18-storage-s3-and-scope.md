# Storage: active-storage scope and the S3 driver

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active storage the library you are looking at, without hiding any
knowledge, and ship a working S3-compatible driver behind a storage settings page that
explains itself.

**Architecture:** The documents list and trash gain an optional `storageDriver` filter,
passed only by the list usecases so background jobs stay unscoped. File reads refuse to
cross storages and answer with the original's location instead, which every driver can
describe offline through a new `describeLocation` contract method. A new
`storage.routes.ts` exposes the driver registry, its setup guides and a health check, and
the Storage settings tab is rebuilt around them. The S3 driver then drops into the
existing registry with no further wiring.

**Tech Stack:** Hono, Drizzle with libsql, valibot, vitest, React with TanStack Query,
`@aws-sdk/client-s3` and `@aws-sdk/lib-storage`.

**Spec:** `docs/superpowers/specs/2026-09-18-storage-drivers-design.md`

**Not in this plan:** the Google Drive driver and the OAuth plumbing (spec sections 3 and
4). They are a second plan, written after this one lands, and they reuse the routes and
the settings tab built here.

## Global Constraints

- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Module file roles are fixed: pure logic in `*.models.ts`, orchestration in
  `*.usecases.ts`, Drizzle only in `*.repository.ts`, Hono only in `*.routes.ts`.
- Every HTTP input parsed with valibot before use. Routes never touch Drizzle.
- Secrets (`accessKeyId`, `secretAccessKey`) are declared `secret: true` so the settings
  module encrypts them at rest. They never appear in a log, an error or a response.
- Registries are plain objects keyed by id. Adding a driver never means editing a switch.
- No `*.tables.ts` change and no migration in this plan. If a task seems to need one,
  stop and raise it.
- Conventional commits, one per task, each leaving the tree green.
- Run from the repo root: `pnpm --filter @docmind/server test`,
  `pnpm --filter @docmind/client test`, `pnpm typecheck`.
- To run one file's tests, use `pnpm --filter @docmind/server exec vitest run <pattern>`.
  `pnpm --filter @docmind/server test -- <pattern>` does NOT filter: the argument never
  reaches vitest and the whole suite runs, which wastes a minute per step and makes a
  "watch it fail" step hard to read.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/storage/storage.types.ts` | contract, gains `describeLocation` and `documentCount` on the driver summary |
| `apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts` | shared suite, gains the `describeLocation` cases |
| `apps/server/src/modules/storage/drivers/local/local.driver.ts` | local `describeLocation` |
| `apps/server/src/modules/storage/drivers/s3/s3.driver.ts` | new S3 driver, settings and guide |
| `apps/server/src/modules/storage/drivers/s3/s3.driver.test.ts` | contract suite against an in-process mock |
| `apps/server/src/modules/storage/storage.registry.ts` | registers `s3` |
| `apps/server/src/modules/storage/storage.routes.ts` | new: list drivers, test a driver |
| `apps/server/src/modules/storage/storage.usecases.ts` | driver summaries, health check, switch guard |
| `apps/server/src/modules/documents/documents.repository.ts` | optional `storageDriver` filter on list and count |
| `apps/server/src/modules/documents/documents.usecases.ts` | list scope, cross-storage read guard |
| `apps/server/src/modules/search/search.types.ts` | `storageDriver` on `SearchResult` |
| `apps/server/src/modules/chat/chat.models.ts` | citation carries the storage, prompt instruction |
| `apps/client/src/pages/settings/StorageTab.tsx` | driver picker, guide, Test, switch confirmation |
| `apps/client/src/lib/storage-api.ts` | new client module for the storage routes |

---

### Task 1: Every driver can say where a file is, offline

**Files:**
- Modify: `apps/server/src/modules/storage/storage.types.ts`
- Modify: `apps/server/src/modules/storage/drivers/local/local.driver.ts`
- Modify: `apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts`
- Test: `apps/server/src/modules/storage/drivers/local/local.driver.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StorageLocation = { label: string; url?: string }` and
  `StorageDriver.describeLocation(args: { key: string }): StorageLocation`, synchronous,
  no network. Tasks 3, 4 and 7 rely on it.

- [ ] **Step 1: Write the failing test**

In `local.driver.test.ts`:

```ts
it("describes where a key lives as an absolute path", () => {
  const driver = createLocalDriver({ root: "./documents" });
  const location = driver.describeLocation({ key: "user_1/2026/09/doc_1/scan.pdf" });
  expect(location.label).toBe(resolve("./documents", "user_1/2026/09/doc_1/scan.pdf"));
  expect(location.url).toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server exec vitest run local.driver`
Expected: FAIL, `describeLocation is not a function`.

- [ ] **Step 3: Add the contract type**

In `storage.types.ts`, above `StorageDriver`:

```ts
// Where a file can be found in its own storage, for a user who wants the original
// rather than a download. Synchronous and network free on purpose: the caller is
// usually asking about a driver that is not active and may not be reachable.
export type StorageLocation = { label: string; url?: string };
```

and inside `StorageDriver`, after `healthCheck`:

```ts
  describeLocation(args: { key: string }): StorageLocation;
```

- [ ] **Step 4: Implement it on the local driver**

In `createLocalDriver`, after `healthCheck`:

```ts
    describeLocation({ key }) {
      return { label: resolveInsideRoot(root, key) };
    },
```

- [ ] **Step 5: Add the case to the shared contract suite**

In `driver-contract.test-utils.ts`, inside the shared describe:

```ts
  it("describes a stored key without touching the network", async () => {
    const driver = await makeDriver();
    await driver.put({ key: "a/b/c.txt", body: Readable.from(["hello"]) });
    const location = driver.describeLocation({ key: "a/b/c.txt" });
    expect(location.label.length).toBeGreaterThan(0);
    expect(location.label).toContain("c.txt");
  });
```

- [ ] **Step 6: Run the storage tests**

Run: `pnpm --filter @docmind/server exec vitest run storage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/storage
git commit -m "feat(server): drivers can say where a file lives without a network call"
```

---

### Task 2: The library shows the active storage, the jobs still see everything

**Files:**
- Modify: `apps/server/src/modules/documents/documents.repository.ts:111-160`
- Modify: `apps/server/src/modules/documents/documents.usecases.ts` (`list`, `counts`)
- Test: `apps/server/src/modules/documents/documents.usecases.test.ts`
- Test: `apps/server/src/modules/search/search.usecases.test.ts` (the job stays unscoped)

**Harness note.** `documents.usecases.test.ts` does not use `createTestApp`. It builds the
services by hand in a `beforeEach` (`createTestDatabase`, `createSettingsService`,
`createStorageService`, `createDocumentsService`) with a module level `const userId =
"user-1"`, and uploads through `documents.upload({ userId, name, mimeType, body })`. Write
the new tests in that style. The file does not import `sql` yet, so add
`import { sql } from "drizzle-orm";` at the top. Do not introduce `createTestApp` into
this file.

**Interfaces:**
- Consumes: `storageService.getActiveDriverId(userId)` (exists).
- Produces: `listByUser`/`countByUser` accept an optional `storageDriver?: string`.
  Absent means unscoped. Task 5 passes it explicitly to count per driver.

- [ ] **Step 1: Write the failing list test**

In `documents.usecases.test.ts`:

```ts
  it("lists only the documents held on the active storage", async () => {
    const { document: elsewhere } = await documents.upload({ userId, name: "elsewhere.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: here } = await documents.upload({ userId, name: "here.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    await db.run(sql`update documents set storage_driver = 's3' where id = ${elsewhere.id}`);

    const listed = await documents.list({ userId });

    expect(listed.map((d) => d.id)).toEqual([here.id]);
  });

  it("counts only the documents held on the active storage", async () => {
    const { document } = await documents.upload({ userId, name: "gone.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await db.run(sql`update documents set storage_driver = 's3', triage_status = 'pending' where id = ${document.id}`);

    expect((await documents.counts({ userId })).inbox).toBe(0);
  });
```

The counts question the plan must answer rather than leave open: the sidebar badges are
counts of the library you are looking at, so they follow the same scope. A badge reading
"3 in inbox" over a list showing none would be a bug, not a feature.

- [ ] **Step 2: Write the failing job test**

In `search.usecases.test.ts`, which does use `createTestApp`:

```ts
  it("re-embeds documents whatever storage holds them", async () => {
    const { t, userId } = await setupWithEmbedding();
    const documentId = await uploadWithText(t, userId, "elsewhere.txt", "Fresh apple pie recipe.");
    await t.db.run(sql`update documents set storage_driver = 's3' where id = ${documentId}`);

    expect((await t.services.searchService.reembedAll({ userId })).count).toBe(1);
  });
```

This one passes before the change and must keep passing after it. It is the guard that the
scope did not leak into the maintenance jobs.

- [ ] **Step 3: Run both and watch the right ones fail**

Run: `pnpm --filter @docmind/server exec vitest run "documents.usecases|search.usecases"`
Expected: the two tests in Step 1 FAIL, the Step 2 test PASSES.

- [ ] **Step 4: Add the optional filter to the repository**

In `listByUser`, add `storageDriver?: string` to the parameter object and its type, then
after the `buildViewConditions` call:

```ts
      // Applied here rather than inside buildViewConditions: that helper is shared with
      // the rule rerun (rules.usecases.ts), the summary backfill (summary.usecases.ts)
      // and reembedAll (search.usecases.ts), and those must keep seeing every document
      // whatever storage holds it.
      if (storageDriver) conditions.push(eq(documentsTable.storageDriver, storageDriver));
```

Add the same parameter and the same two lines to `countByUser`.

- [ ] **Step 5: Pass the active driver from the two library usecases**

In `documents.usecases.ts`, in `list`:

```ts
      const storageDriver = await storageService.getActiveDriverId(userId);
      return repository.listByUser({ userId, categoryId, tagId, view, storageDriver });
```

and in `counts`, resolve `storageDriver` once and pass it to all three `countByUser`
calls. Change no other caller of either method.

- [ ] **Step 6: Run the suites**

Run: `pnpm --filter @docmind/server exec vitest run "documents|search"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/documents apps/server/src/modules/search
git commit -m "feat(server): the library lists and counts the active storage only"
```

---

### Task 3: Reading a file across storages is refused, with the location

**Files:**
- Modify: `apps/server/src/modules/documents/documents.usecases.ts:163-176`
- Test: `apps/server/src/modules/documents/documents.usecases.test.ts`

**Interfaces:**
- Consumes: `describeLocation` from Task 1, `getActiveDriverId`.
- Produces: error code `documents.storage_inactive`, status 409, message naming the
  storage and the location. Task 6 renders it.

- [ ] **Step 1: Write the failing test**

Same hand-built harness as Task 2, and `expectAppError` is already imported in this file:

```ts
  it("refuses to open a file held on another storage, and says where it is", async () => {
    const { document } = await documents.upload({ userId, name: "elsewhere.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await db.run(sql`update documents set storage_driver = 's3' where id = ${document.id}`);

    await expectAppError(() => documents.openFile({ userId, documentId: document.id }), "documents.storage_inactive");

    // The metadata is knowledge and stays reachable.
    expect((await documents.get({ userId, documentId: document.id })).id).toBe(document.id);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server exec vitest run documents.usecases`
Expected: FAIL, the call resolves instead of rejecting.

- [ ] **Step 3: Add the guard**

In `documents.usecases.ts`, a helper above `openFile`:

```ts
    // The bytes need their storage, the metadata does not. A document on an inactive
    // storage stays fully readable as a record and refuses only the file itself, with
    // the original's location in the message so the user can go and get it.
    async function requireActiveStorage(userId: string, document: Document) {
      const active = await storageService.getActiveDriverId(userId);
      if (document.storageDriver === active) return;
      const driver = await storageService.getDriver(userId, document.storageDriver);
      const location = driver.describeLocation({ key: document.storageKey });
      throw createError({
        code: "documents.storage_inactive",
        message: `This file is stored on ${document.storageDriver}, which is not the active storage. The original is at ${location.label}.`,
        status: 409,
      });
    }
```

Call it at the top of `openFile` and of `purge`, after the document is loaded. Do not call
it in `restore`, which only moves metadata.

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @docmind/server exec vitest run documents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/documents
git commit -m "feat(server): refuse cross storage file reads and name the original"
```

---

### Task 4: Search results and chat citations name their storage

**Files:**
- Modify: `apps/server/src/modules/search/search.types.ts`
- Modify: `apps/server/src/modules/search/search.usecases.ts` (the result assembly)
- Modify: `apps/server/src/modules/chat/chat.types.ts`, `chat.models.ts`,
  `chat.usecases.ts:132-140`
- Test: `apps/server/src/modules/search/search.usecases.test.ts`,
  `apps/server/src/modules/chat/chat.models.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SearchResult.storageDriver: string` and `Citation.storageDriver: string`.
  Task 6 renders the badge from them.

- [ ] **Step 1: Write the failing tests**

In `search.usecases.test.ts`:

```ts
it("says which storage holds each result, whatever the active storage is", async () => {
  const { t, userId, runner } = await setupWithEmbedding();
  const documentId = await uploadWithText(t, userId, "apple.txt", "Fresh apple pie recipe.");
  await t.db.run(sql`update documents set storage_driver = 's3' where id = ${documentId}`);
  await enqueueAndRun(t, runner, userId, documentId);

  const results = await t.services.searchService.search({ userId, query: "apple" });

  expect(results[0]?.storageDriver).toBe("s3");
});
```

In `chat.models.test.ts`, extend the context block test. `buildContextBlock` is declared
without `export` at `chat.models.ts:45`, so export it as part of this step:

```ts
it("names the storage of a cited document that is not on the active storage", () => {
  const block = buildContextBlock([
    { documentId: "doc_1", documentName: "policy.pdf", chunkText: "cover", chunkIndex: 0, storageDriver: "googleDrive" },
  ]);
  expect(block).toContain("googleDrive");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run "search.usecases|chat.models"`
Expected: FAIL on the missing property.

- [ ] **Step 3: Carry the driver through search**

Add `storageDriver: string;` to `SearchResult` in `search.types.ts`, and in the result
assembly in `search.usecases.ts` set it from the document row that is already loaded:

```ts
        storageDriver: document.storageDriver,
```

Do the same in the filename-match branch below it.

- [ ] **Step 4: Carry it through chat**

Add `storageDriver: string;` to `Citation` in `chat.types.ts`, map it in
`chat.usecases.ts` where chunks are built from search results, and in `buildContextBlock`
include it in each chunk's header line, for example
`[1] policy.pdf (stored on googleDrive)`.

- [ ] **Step 5: Tell the model what to do with it**

In `CHAT_SYSTEM_PROMPT`, add one line:

```
When a document you cite is stored somewhere other than the active storage, say which
storage holds it and that the file has to be opened there. Never imply it can be opened
from this page.
```

- [ ] **Step 6: Run the suites**

Run: `pnpm --filter @docmind/server exec vitest run "search|chat"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/search apps/server/src/modules/chat
git commit -m "feat(server): search and chat name the storage holding each document"
```

---

### Task 5: Storage routes, so the settings page has something to read

**Files:**
- Create: `apps/server/src/modules/storage/storage.routes.ts`
- Create: `apps/server/src/modules/storage/storage.routes.test.ts`
- Modify: `apps/server/src/modules/storage/storage.usecases.ts` (factory signature)
- Modify: `apps/server/src/server.ts:146` (pass `db`) and the route registration block
- Modify: `apps/server/src/modules/storage/storage.usecases.test.ts:30` (factory call)
- Modify: `apps/server/src/modules/documents/documents.usecases.test.ts:32` (factory call)

**Breaking change, handled in this task.** `createStorageService({ settingsService })` has
to learn the document counts, so it becomes
`createStorageService({ settingsService, db })` and builds
`createDocumentsRepository({ db })` internally. There are exactly three call sites, all
listed above, and all three must change in this commit or typecheck fails. Do not leave
`db` optional: an optional dependency here would mean a summary that silently reports zero
documents.

**Interfaces:**
- Consumes: the registry, `countByUser({ userId, view, storageDriver })` from Task 2.
- Produces: `GET /api/storage/drivers` returning
  `{ drivers: { id, label, guide, configured, documentCount, active }[] }`, and
  `POST /api/storage/drivers/:id/test` returning `{ ok, message }`. Task 6 calls both.

- [ ] **Step 1: Write the failing tests**

`storage.routes.test.ts`, following `fields.routes.test.ts` exactly: `createTestApp()`,
`t.signIn()` for the `cookie`, and `t.app.request(...)` with that cookie on every call.
There is no `t.request`.

```ts
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ cookie, userId } = await t.signIn());
});

describe("storage routes", () => {
  it("requires a session", async () => {
    expect((await t.app.request("/api/storage/drivers")).status).toBe(401);
  });

  it("lists each driver with its guide, readiness and document count", async () => {
    await t.services.documentsService.upload({ userId, name: "one.txt", mimeType: "text/plain", body: Readable.from(["a"]) });

    const res = await t.app.request("/api/storage/drivers", { headers: { cookie } });
    const body = (await res.json()) as { drivers: { id: string; label: string; configured: boolean; documentCount: number; active: boolean; guide: { steps: unknown[] } }[] };

    expect(res.status).toBe(200);
    const local = body.drivers.find((d) => d.id === "local")!;
    expect(local).toMatchObject({ label: "Local filesystem", configured: true, documentCount: 1, active: true });
    expect(local.guide.steps.length).toBeGreaterThan(0);
  });

  it("runs a driver's health check on demand", async () => {
    const res = await t.app.request("/api/storage/drivers/local/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects an unknown driver id before it reaches the registry", async () => {
    const res = await t.app.request("/api/storage/drivers/nope/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server exec vitest run storage.routes`
Expected: FAIL, 404 on every route.

- [ ] **Step 3: Thread `db` into the storage service**

In `storage.usecases.ts`:

```ts
export function createStorageService({ settingsService, db }: { settingsService: SettingsService; db: Database }) {
  const documentsRepository = createDocumentsRepository({ db });
```

Update `server.ts:146` to `createStorageService({ settingsService, db })`, and the two test
call sites to pass the `db` each already has in scope.

- [ ] **Step 4: Define what "configured" means, in code**

`SettingDefinition` has no `required` flag, so readiness is derived: a driver is configured
when every one of its settings that has no `default` and is not `internal` resolves to a
non-empty value. Local's only setting has a default, so local is always ready. S3's
bucket, region, access key and secret have no default, so S3 is ready only once they are
filled. Add to `storage.usecases.ts`:

```ts
  // A driver is ready when nothing it cannot invent is missing. Settings that carry a
  // default (prefix, path style) are never the reason a driver is unusable, so only the
  // ones without one are checked.
  async function isConfigured({ definition, userId }: { definition: StorageDriverDefinition; userId: string }) {
    const required = definition.settings.filter((setting) => setting.default === undefined && !setting.internal);
    for (const setting of required) {
      const value = await settingsService.get<unknown>(userId, setting.key);
      if (value === undefined || value === null || value === "") return false;
    }
    return true;
  }
```

- [ ] **Step 5: Add the two usecases**

```ts
    // One call renders the whole picker: what exists, what is ready, what it holds, and
    // the guide that explains the fields.
    async listDriverSummaries(userId: string) {
      const active = await this.getActiveDriverId(userId);
      return Promise.all(
        Object.values(storageDriverRegistry).map(async (definition) => ({
          id: definition.id,
          label: definition.label,
          guide: definition.guide,
          configured: await isConfigured({ definition, userId }),
          documentCount: await documentsRepository.countByUser({ userId, view: "all", storageDriver: definition.id }),
          active: definition.id === active,
        })),
      );
    },

    async testDriver({ userId, driverId }: { userId: string; driverId: string }) {
      return (await this.getDriver(userId, driverId)).healthCheck();
    },
```

- [ ] **Step 6: Add the routes**

`storage.routes.ts` in the shape of `fields.routes.ts`, taking `{ app, storageService,
getUserId }`. Parse `:id` with `v.picklist(storageDriverIds)` through
`parseOrValidationError`, so an unknown id is a 400 and never reaches the registry.

- [ ] **Step 7: Register and run**

Register in `server.ts` beside the other `register*Routes` calls.
Run: `pnpm --filter @docmind/server test` then `pnpm typecheck`
Expected: PASS, including the two edited test files.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src
git commit -m "feat(server): expose the storage drivers, their guides and a health check"
```

---

### Task 6: The Storage settings tab

**Files:**
- Create: `apps/client/src/lib/storage-api.ts`
- Rewrite: `apps/client/src/pages/settings/StorageTab.tsx`
- Rewrite: `apps/client/src/pages/settings/StorageTab.test.tsx` (the file exists and
  asserts the old behavior: editing `storage.activeDriver` through a bare input and
  `settingsApi.update`. Those assertions are replaced, not added to, because the rewrite
  removes the input they drive.)

**Interfaces:**
- Consumes: both routes from Task 5, the settings API for writing driver settings.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the active driver, its guide, and only its settings", async () => { /* ... */ });

it("asks for confirmation naming the counts before switching storage", async () => {
  renderStorageTab({ drivers: [localWith(12), s3With(0)] });
  await userEvent.click(screen.getByRole("button", { name: /switch to amazon s3/i }));
  expect(screen.getByText(/12 documents on Local filesystem will leave the library/i)).toBeInTheDocument();
  expect(screen.getByText(/search and chat keep finding all of them/i)).toBeInTheDocument();
});

it("refuses to switch while the health check fails", async () => { /* ... */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/client exec vitest run StorageTab`
Expected: FAIL, the elements do not exist.

- [ ] **Step 3: Write the client api module**

`storage-api.ts` with `list()` and `test(id)`, following `fields-api.ts` exactly.

- [ ] **Step 4: Rebuild the tab**

A driver list on the left (label, a badge for active, the document count), the selected
driver's settings and guide on the right, a Test button, and a Switch button that opens a
confirmation naming both counts and the sentence about search and chat. Reuse
`ProviderCard.tsx`'s guide rendering rather than writing a second one.

- [ ] **Step 5: Run the suites**

Run: `pnpm --filter @docmind/client exec vitest run StorageTab` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src
git commit -m "feat(client): a storage tab with a driver picker, guides and a test button"
```

---

### Task 7: The S3-compatible driver

**Files:**
- Create: `apps/server/src/modules/storage/drivers/s3/s3.driver.ts`
- Create: `apps/server/src/modules/storage/drivers/s3/s3.driver.test.ts`
- Modify: `apps/server/src/modules/storage/storage.registry.ts`
- Modify: `apps/server/package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`)

**Interfaces:**
- Consumes: `StorageDriverDefinition`, `StorageLocation`, the contract suite.
- Produces: registry entry `s3`, settings under `storage.s3.`.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter @docmind/server add @aws-sdk/client-s3 @aws-sdk/lib-storage
```

- [ ] **Step 2: Build the fake S3, multipart aware**

This is the part that decides whether Task 7 is buildable, so it is specified rather than
described. `lib-storage`'s `Upload` cannot know the length of a Node `Readable` up front,
so it always runs the multipart sequence, even for eleven bytes. A fake that only answers
PutObject would let `put` resolve while storing nothing, and the very next `get` in the
contract suite would fail with a confusing 404. The fake therefore understands multipart.

In `s3.driver.test.ts`:

```ts
import { Readable } from "node:stream";
import {
  CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand,
  GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, UploadPartCommand,
} from "@aws-sdk/client-s3";

// An in-memory S3 that speaks the subset lib-storage actually uses. Keyed by the full
// object key, so the driver's prefix handling is exercised rather than mocked away.
function createFakeS3() {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  let nextUploadId = 1;

  const send = async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = `upload-${nextUploadId++}`;
      uploads.set(uploadId, []);
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const { UploadId, PartNumber, Body } = command.input;
      const parts = uploads.get(UploadId!)!;
      parts[PartNumber! - 1] = Buffer.from(Body as Uint8Array);
      return { ETag: `"etag-${PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const { UploadId, Key } = command.input;
      objects.set(Key!, Buffer.concat(uploads.get(UploadId!)!));
      uploads.delete(UploadId!);
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const { Key, Body } = command.input;
      objects.set(Key!, Buffer.from(Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([body]) };
    }
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(command.input.Key!)) throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: objects.get(command.input.Key!)!.length };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof HeadBucketCommand) return {};
    throw new Error(`Fake S3 received an unhandled command: ${(command as object).constructor.name}`);
  };

  return { objects, client: { send, config: { region: async () => "auto" } } as never };
}
```

The final `throw` matters: when a later change makes the driver send a command the fake
does not know, the test says exactly which one instead of hanging or silently passing.

- [ ] **Step 3: Write the failing tests**

```ts
const { client } = createFakeS3();
runStorageDriverContract("s3", async () => createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client }));

it("describes a key as an s3 url including the prefix", () => {
  const driver = createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client });
  expect(driver.describeLocation({ key: "user_1/a.pdf" }).label).toBe("s3://docs/docmind/user_1/a.pdf");
});

it("round trips a body larger than one multipart chunk", async () => {
  const driver = createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client });
  const big = Buffer.alloc(6 * 1024 * 1024, "x");
  await driver.put({ key: "big.bin", body: Readable.from([big]) });
  const chunks: Buffer[] = [];
  for await (const c of await driver.get({ key: "big.bin" })) chunks.push(Buffer.from(c));
  expect(Buffer.concat(chunks).length).toBe(big.length);
});
```

Run: `pnpm --filter @docmind/server exec vitest run s3.driver`
Expected: FAIL, the module does not exist.

- [ ] **Step 4: Implement the driver**

`createS3Driver({ bucket, region, endpoint, prefix, forcePathStyle, client })` returning a
`StorageDriver`: `put` through lib-storage's `Upload` so the body streams, `get` returning
the response `Body` as a `Readable`, `delete` as DeleteObject, `exists` as HeadObject with
a 404 mapped to `false`, `healthCheck` as HeadBucket then a put and delete of
`<prefix>.docmind-health`, and `describeLocation` returning the `s3://` label.

- [ ] **Step 5: Declare the settings and the guide**

Seven settings under `storage.s3.` per the spec, with `accessKeyId` and
`secretAccessKey` marked secret. The guide gives the minimal IAM policy as a `copyValue`
and the endpoint shapes for R2, Backblaze and MinIO.

- [ ] **Step 6: Register it**

```ts
export const storageDriverRegistry = {
  local: localDriverDefinition,
  s3: s3DriverDefinition,
} as const satisfies Record<string, StorageDriverDefinition>;
```

- [ ] **Step 7: Run everything**

Run: `pnpm --filter @docmind/server test` then `pnpm typecheck`
Expected: PASS. The Storage tab from Task 6 now shows two drivers with no further change.

- [ ] **Step 8: Commit**

```bash
git add apps/server package.json pnpm-lock.yaml
git commit -m "feat(server): S3 compatible storage driver"
```

---

## Self-review

**Spec coverage.** Section 1 is Tasks 2 and 3, section 1a is Task 1, section 2 is Task 7,
section 5 is Tasks 5 and 6, and the scope and guard tests of section 6 are spread across
Tasks 2, 3 and 4. Sections 3 and 4 (Google Drive, OAuth) are deferred to the second plan,
as the header states. The spec's "results carry the storage that holds them" line sits
inside section 1 and is implemented by Task 4.

**Questions this plan answers rather than leaves open.**

- The sidebar counts follow the library scope (Task 2, with a test). A badge counting
  documents the list does not show would be a bug.
- "Configured" is defined as every setting without a `default` having a non-empty value
  (Task 5), because `SettingDefinition` carries no `required` flag to read.
- `createStorageService` gains `db` as a required dependency, and all three call sites are
  named in Task 5 so the change lands in one commit rather than breaking typecheck.
- The S3 fake speaks multipart (Task 7), because `lib-storage` always takes the multipart
  path for a stream body whatever its size.

**Verified against the tree.** `documents.usecases.test.ts` hand-builds its services and
has no `createTestApp` and no `uploadDocument` helper, so Tasks 2 and 3 are written in its
own style. Route tests use `t.app.request` with the cookie from `t.signIn()`; there is no
`t.request`. `buildContextBlock` is not exported today, so Task 4 exports it.
`StorageTab.test.tsx` already exists and is rewritten, not extended.

**No migration.** No task touches a `*.tables.ts` file or the shape of a stored column.
`documents.storage_driver` and `documents.storage_key` already exist.

**Type consistency.** `StorageLocation`, `describeLocation`, the `storageDriver` field on
`SearchResult` and `Citation`, and the `configured`/`documentCount`/`active` summary
fields are spelled identically in every task that mentions them.
