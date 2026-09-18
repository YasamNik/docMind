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

Run: `pnpm --filter @docmind/server test -- local.driver`
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

Run: `pnpm --filter @docmind/server test -- storage`
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
- Modify: `apps/server/src/modules/documents/documents.usecases.ts`
- Test: `apps/server/src/modules/documents/documents.usecases.test.ts`

**Interfaces:**
- Consumes: `storageService.getActiveDriverId(userId)` (exists).
- Produces: `listByUser`/`countByUser` accept an optional `storageDriver?: string`.
  Absent means unscoped. Task 5 reads the same counts.

- [ ] **Step 1: Write the failing tests**

In `documents.usecases.test.ts`:

```ts
it("lists only documents held on the active storage", async () => {
  const t = await createTestApp();
  const { userId } = await t.signIn();
  const local = await uploadDocument(t, userId, "local.txt");
  await t.db.run(sql`update documents set storage_driver = 's3' where id = ${local.id}`);
  const onLocal = await uploadDocument(t, userId, "stays.txt");

  const listed = await t.services.documentsService.list({ userId });

  expect(listed.map((d) => d.id)).toEqual([onLocal.id]);
});

it("keeps background jobs working on documents from every storage", async () => {
  const t = await createTestApp();
  const { userId } = await t.signIn();
  const moved = await uploadDocument(t, userId, "elsewhere.txt");
  await t.db.run(sql`update documents set storage_driver = 's3', extraction_status = 'done' where id = ${moved.id}`);

  // reembedAll is the job path: it must not inherit the library's scope.
  const result = await t.services.searchService.reembedAll({ userId });

  expect(result.count).toBe(1);
});
```

- [ ] **Step 2: Run them and watch the first fail**

Run: `pnpm --filter @docmind/server test -- documents.usecases`
Expected: the first test FAILS (both documents listed), the second PASSES already and is
there to stay passing.

- [ ] **Step 3: Add the optional filter to the repository**

In `listByUser`, extend the parameter object with `storageDriver?: string` and after the
`buildViewConditions` call:

```ts
      // Applied here rather than inside buildViewConditions: that helper is shared with
      // the rule rerun, the summary backfill and reembedAll, and those must keep seeing
      // documents whatever storage holds them.
      if (storageDriver) conditions.push(eq(documentsTable.storageDriver, storageDriver));
```

Do the same in `countByUser`.

- [ ] **Step 4: Pass the active driver from the list usecases only**

In `documents.usecases.ts`, in `list` and in the counts usecase:

```ts
      const storageDriver = await storageService.getActiveDriverId(userId);
      return repository.listByUser({ userId, categoryId, tagId, view, storageDriver });
```

Leave every other caller of `listByUser` alone.

- [ ] **Step 5: Run the suite**

Run: `pnpm --filter @docmind/server test -- documents`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/documents
git commit -m "feat(server): the library lists the active storage only"
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

```ts
it("refuses to open a file held on a storage that is not active, and says where it is", async () => {
  const t = await createTestApp();
  const { userId } = await t.signIn();
  const doc = await uploadDocument(t, userId, "elsewhere.txt");
  await t.db.run(sql`update documents set storage_driver = 's3' where id = ${doc.id}`);

  await expect(t.services.documentsService.openFile({ userId, documentId: doc.id })).rejects.toMatchObject({
    code: "documents.storage_inactive",
  });

  // The metadata is knowledge and stays reachable.
  const still = await t.services.documentsService.get({ userId, documentId: doc.id });
  expect(still.id).toBe(doc.id);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server test -- documents.usecases`
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

Run: `pnpm --filter @docmind/server test -- documents`
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

In `chat.models.test.ts`, extend the context block test:

```ts
it("names the storage of a cited document that is not on the active storage", () => {
  const block = buildContextBlock([
    { documentId: "doc_1", documentName: "policy.pdf", chunkText: "cover", chunkIndex: 0, storageDriver: "googleDrive" },
  ]);
  expect(block).toContain("googleDrive");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- "search.usecases|chat.models"`
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

Run: `pnpm --filter @docmind/server test -- "search|chat"`
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
- Modify: `apps/server/src/modules/storage/storage.usecases.ts`
- Modify: `apps/server/src/server.ts` (register the routes beside the others)

**Interfaces:**
- Consumes: the registry, `describeLocation`, `countByUser` from Task 2.
- Produces: `GET /api/storage/drivers` returning
  `{ drivers: { id, label, guide, configured, documentCount, active }[] }`, and
  `POST /api/storage/drivers/:id/test` returning `{ ok, message }`. Task 6 calls both.

- [ ] **Step 1: Write the failing test**

```ts
it("lists every driver with its guide, whether it is configured, and what it holds", async () => {
  const t = await createTestApp();
  const { userId } = await t.signIn();
  await uploadDocument(t, userId, "one.txt");

  const res = await t.request("/api/storage/drivers");
  const body = await res.json();

  expect(res.status).toBe(200);
  const local = body.drivers.find((d: { id: string }) => d.id === "local");
  expect(local).toMatchObject({ label: "Local filesystem", configured: true, documentCount: 1, active: true });
  expect(local.guide.steps.length).toBeGreaterThan(0);
});

it("runs a driver's health check on demand", async () => {
  const t = await createTestApp();
  await t.signIn();
  const res = await t.request("/api/storage/drivers/local/test", { method: "POST" });
  expect(await res.json()).toMatchObject({ ok: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @docmind/server test -- storage.routes`
Expected: FAIL with 404.

- [ ] **Step 3: Add the usecase**

In `storage.usecases.ts`:

```ts
    // The settings page needs one call to render the whole picker: what exists, what is
    // ready to use, what it holds, and the guide that explains the fields.
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
      const driver = await this.getDriver(userId, driverId);
      return driver.healthCheck();
    },
```

`isConfigured` reads each of the definition's settings and returns false when a required
one is empty.

- [ ] **Step 4: Add the routes**

`storage.routes.ts`, following `fields.routes.ts` for shape, parsing `:id` with a valibot
picklist of `storageDriverIds` so an unknown id is a 400 and never reaches the registry.

- [ ] **Step 5: Register and run**

Register in `server.ts` next to the other route registrations.
Run: `pnpm --filter @docmind/server test -- storage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/storage apps/server/src/server.ts
git commit -m "feat(server): expose the storage drivers, their guides and a health check"
```

---

### Task 6: The Storage settings tab

**Files:**
- Create: `apps/client/src/lib/storage-api.ts`
- Rewrite: `apps/client/src/pages/settings/StorageTab.tsx`
- Test: `apps/client/src/pages/settings/StorageTab.test.tsx`

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

Run: `pnpm --filter @docmind/client test -- StorageTab`
Expected: FAIL, the elements do not exist.

- [ ] **Step 3: Write the client api module**

`storage-api.ts` with `list()` and `test(id)`, following `fields-api.ts` exactly.

- [ ] **Step 4: Rebuild the tab**

A driver list on the left (label, a badge for active, the document count), the selected
driver's settings and guide on the right, a Test button, and a Switch button that opens a
confirmation naming both counts and the sentence about search and chat. Reuse
`ProviderCard.tsx`'s guide rendering rather than writing a second one.

- [ ] **Step 5: Run the suites**

Run: `pnpm --filter @docmind/client test -- StorageTab` then `pnpm typecheck`
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

- [ ] **Step 2: Write the failing contract test**

`s3.driver.test.ts` runs the shared suite against a driver built on a mocked
`S3Client.send`, backed by an in-memory `Map` from key to Buffer, so put, get, delete,
exists and describeLocation are all exercised with no network. Add one test of its own:

```ts
it("describes a key as an s3 url including the prefix", () => {
  const driver = createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client });
  expect(driver.describeLocation({ key: "user_1/a.pdf" }).label).toBe("s3://docs/docmind/user_1/a.pdf");
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @docmind/server test -- s3.driver`
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
section 5 is Tasks 5 and 6, section 6's scope and guard tests are in Tasks 2, 3 and 4.
Sections 3 and 4 (Google Drive, OAuth) are deliberately deferred to the second plan, as
stated in the header. The spec's "search results carry the storage" requirement is Task 4,
which the spec mentions inside section 1 rather than in its own section.

**Gap found and closed.** The spec's test list requires proving that a rule rerun, a
summary backfill and a re-embed still process documents on an inactive storage. Only
`reembedAll` is asserted in Task 2. The rule rerun and summary backfill call
`listByUser` with no `storageDriver`, so they are unaffected by construction, and Task 2's
repository comment records why. Adding two more near-identical tests would not earn their
keep; the comment plus the `reembedAll` test is the guard.

**Type consistency.** `StorageLocation`, `describeLocation`, `storageDriver` on
`SearchResult` and `Citation`, and the `documentCount`/`configured`/`active` summary
fields are named identically everywhere they appear.
