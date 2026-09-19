# Storage drivers: S3 compatible and Google Drive. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an S3 compatible driver and a Google Drive driver beside the existing local driver, both configurable from the Settings page, with an OAuth connect flow for Drive. The active driver receives new uploads. Every existing document keeps reading from the driver recorded on its row.

**Architecture:** `StorageDriver` does not change. `StorageDriverDefinition` gains `requiredSettings` and an optional `oauth` block. A new `storage.errors.ts` pins a ten code error vocabulary that every driver maps into. A new `storage.routes.ts` exposes driver status, test connection and disconnect. Google Drive talks to the Drive v3 REST API through an injected `fetchImpl`; S3 talks through an injected client factory, so the shared contract suite runs both against fakes. Nothing about the data model changes: the refresh token lives in the existing `settings` table.

**Tech Stack:** Hono, TypeScript, Drizzle over libsql (SQLite), valibot, vitest, pino. New server dependencies: `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`, in task 5 only. Client: React, Vite, Tailwind, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-18-storage-drivers-gdrive-s3.md` at commit `5e7a943`. Read it in full before starting. Its decisions list (1 to 16, including 8b) and its Rulings section explain every non-obvious choice, and this plan does not repeat the reasoning, only the work.

**Baseline:** every line number below was read at commit `d820ef6` on branch `feat/document-types`. Other agents are committing to this branch. Each line number comes with the exact text of the line, so when the number has drifted, search for the text.

## Global Constraints

Binding project conventions, quoted from `CLAUDE.md` and `.claude/rules/server-modules.md`:

- **Valibot for every boundary:** HTTP input, env and settings, LLM output. Every request body, query and param is parsed with valibot before use.
- **Secrets go through the settings module only.** They are encrypted at rest and never logged or returned by the API. Mask to the last four characters. This is the whole reason task 1 exists.
- **Drizzle for every database access. No raw SQL outside migrations and the vector table.**
- **Modules are self-contained** under `apps/server/src/modules/<name>/`, files named by role: `*.routes.ts`, `*.usecases.ts`, `*.models.ts`, `*.repository.ts`, `*.config.ts`, `*.schemas.ts`, `*.types.ts`. **Pure logic in models, orchestration in usecases, database access in repositories.** Routes never touch Drizzle. Models never import from repositories or services.
- **No em dashes anywhere:** code, comments, docs, commit messages, UI copy, replies to the user. Use a comma, a colon, a hyphen, or a new sentence.
- **Conventional commits.** Every commit message in this plan ends with exactly these two lines:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

Two repository facts that will bite an implementer who does not know them:

- **No server test file is ever typechecked.** `apps/server/tsconfig.json` line 9 excludes `src/**/*.test.ts` from the program. Adding a required parameter to a test factory, changing a service constructor signature, or renaming an export will not fail `pnpm typecheck`. It will fail at runtime later, in a test nobody ran. Note that a `*.test-utils.ts` file does not match that glob and is typechecked, so `driver-contract.test-utils.ts` compiles while `local.driver.test.ts` which calls it does not. Every task here that changes a signature names the grep to run over call sites by hand.
- **`ref_code/` is reference only.** Never copy from it, never import it, never add it to a build or test path. It is absent from this checkout anyway, so any instruction that seems to depend on it is wrong.

**No migration is needed for this item, and that is a checked fact, not an omission.** No task in this plan touches any `*.tables.ts` file. The one piece of new durable state, the Google Drive refresh token, is a row in the existing `settings` table, which is a key and value table built for exactly this. Before the final commit, run a diff of every tables file against main and confirm it is empty. If any task finds itself wanting a column, stop and follow `.claude/rules/schema-changes.md`: generate the migration in the same task, or do not add the column.

**Verification commands:** `pnpm --filter @docmind/server test`, `pnpm --filter @docmind/client test`, `pnpm typecheck`, from the repository root.

## File Structure

| File | Change | Task |
|------|--------|------|
| `apps/server/src/modules/settings/settings.usecases.ts` | `setInternal` encrypts secrets, supports clearing | 1 |
| `apps/server/src/modules/settings/settings.usecases.test.ts` | regression tests for the above | 1 |
| `apps/server/src/modules/storage/storage.errors.ts` | NEW, the ten code vocabulary | 2 |
| `apps/server/src/modules/storage/storage.types.ts` | `requiredSettings`, `StorageOauthDefinition` | 2 |
| `apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts` | four new contract tests, `largeBodyBytes` option | 2 |
| `apps/server/src/modules/storage/drivers/local/local.driver.ts` | `requiredSettings: []` | 2 |
| `apps/server/src/modules/documents/documents.repository.ts` | `countByDriver` | 3 |
| `apps/server/src/modules/documents/documents.usecases.ts` | injectable logger, `purge` tolerates an unreachable driver, `countByDriver` | 3 |
| `apps/server/src/modules/export/export.usecases.ts` | record skipped documents in the manifest | 3 |
| `apps/server/src/modules/storage/storage.usecases.ts` | injectable registry, `listDriverStatus`, `testDriver`, `assertStorageUpdatesValid`, `lastAuthError` | 4 |
| `apps/server/src/modules/storage/storage.schemas.ts` | NEW, driver id picklist and callback query | 4 |
| `apps/server/src/modules/storage/storage.routes.ts` | NEW, status, test, disconnect | 4 |
| `apps/server/src/server.ts` | storage branch in `beforeSet`, register routes | 4, 10 |
| `DOCMIND-DESIGN.md` | credential clearing rule | 4 |
| `apps/server/src/modules/storage/drivers/s3/s3.models.ts` | NEW, pure keys, client config, error mapping | 5 |
| `apps/server/src/modules/storage/drivers/s3/s3.guide.ts` | NEW | 5 |
| `apps/server/src/modules/storage/drivers/s3/s3.driver.ts` | NEW | 5 |
| `apps/server/src/modules/storage/storage.registry.ts` | register `s3`, then `gdrive` | 5, 9 |
| `apps/client/src/pages/settings/SetupGuide.tsx` | NEW, extracted from `ProviderCard` | 6 |
| `apps/client/src/pages/settings/ProviderCard.tsx` | use `SetupGuide` | 6 |
| `apps/client/src/lib/storage-api.ts` | NEW | 6 |
| `apps/client/src/pages/settings/StorageDriverCard.tsx` | NEW | 6 |
| `apps/client/src/pages/settings/StorageTab.tsx` | REWRITTEN | 6 |
| `apps/server/src/modules/storage/drivers/gdrive/gdrive.models.ts` | NEW, pure ranges, expiry, error mapping | 7 |
| `apps/server/src/modules/storage/drivers/gdrive/gdrive.fetch.test-utils.ts` | NEW, the in-memory Drive fake | 7 |
| `apps/server/src/modules/storage/drivers/gdrive/gdrive.tokens.ts` | NEW, module scoped access token cache | 8 |
| `apps/server/src/modules/storage/drivers/gdrive/gdrive.api.ts` | NEW, fetch wrappers | 8 |
| `apps/server/src/modules/storage/drivers/gdrive/gdrive.driver.ts` | NEW | 9 |
| `apps/server/src/modules/storage/drivers/gdrive/gdrive.guide.ts` | NEW | 9 |
| `apps/server/src/modules/storage/storage.oauth.models.ts` | NEW, state sign and verify, authorize URL | 10 |
| `apps/server/src/modules/storage/storage.oauth.usecases.ts` | NEW, code exchange, connect, disconnect | 10 |
| `apps/server/src/modules/storage/storage.oauth.routes.ts` | NEW, start and callback | 10 |
| `apps/server/.env.example` | S3 and GDRIVE seeds | 11 |
| `docs/FEATURES.md` | item 9 progress | 11 |
| `DOCMIND-DESIGN.md` | `storage.oauth.redirectBaseUrl` setting | 11 |

Eleven tasks. Each one leaves the tree compiling, the suites green, and the app usable.

---

### Task 1: setInternal must encrypt a secret internal setting

A bug fix in shipped code, not a feature step, so it follows the bug fix workflow in `CLAUDE.md`: check history, write the regression test, watch it fail, fix, run the suite, propose the record. It is first because task 10 stores a Google refresh token through `setInternal`, and until this lands that token is written to the database in plaintext and then fails to read back.

Read the spec section "Bug found in shipped code: setInternal stores a secret setting in plaintext" before starting.

**Files:**
- Modify: `apps/server/src/modules/settings/settings.usecases.ts`
- Test: `apps/server/src/modules/settings/settings.usecases.test.ts`

**Interfaces:**
- Consumed: `encryptSecret` and `decryptSecret` from `./settings.crypto.js`, already imported at line 4.
- Produced: `setInternal(userId, key, value)` encrypts when `definition.secret` is true, and removes the row when `value` is null.

- [ ] **Step 0: Check the bug history first**

Read `docs/bugs_fix_tracking.md` and search it for `setInternal` and for `bad_ciphertext`. If this is already recorded, stop and report when and how it was fixed rather than fixing it twice.

- [ ] **Step 1: Write the failing regression test**

In `settings.usecases.test.ts`, add one definition to the `definitions` array at lines 11 to 16, beside the existing `test.internalDimension` at line 15:

```ts
  defineSetting({ key: "test.internalToken", schema: v.string(), secret: true, internal: true, doc: "Internal secret" }),
```

Then add three tests at the end of `describe("settings service")`:

```ts
  it("setInternal stores a secret internal setting as ciphertext and reads it back", async () => {
    const s = await service();
    await s.setInternal(user, "test.internalToken", "1//refresh-token-value");
    const row = (await s.debugRows(user)).find((r) => r.key === "test.internalToken");
    expect(row?.value.startsWith("enc:v1:")).toBe(true);
    expect(await s.get(user, "test.internalToken")).toBe("1//refresh-token-value");
  });

  it("setInternal with null removes the row", async () => {
    const s = await service();
    await s.setInternal(user, "test.internalToken", "1//refresh-token-value");
    await s.setInternal(user, "test.internalToken", null);
    expect((await s.debugRows(user)).find((r) => r.key === "test.internalToken")).toBeUndefined();
    expect(await s.get(user, "test.internalToken")).toBeUndefined();
  });

  it("an internal secret stays off the public API surface", async () => {
    const s = await service();
    await s.setInternal(user, "test.internalToken", "1//refresh-token-value");
    expect((await s.listResolved(user)).map((r) => r.key)).not.toContain("test.internalToken");
    await expectAppError(() => s.set(user, { "test.internalToken": "x" }), "settings.internal_only");
  });
```

Also assert the stored secret flag. Open `settings.repository.ts` first and use whatever name the `listForUser` select gives that column, since `debugRows` is a straight pass through of it (`settings.usecases.ts:186`). Do not guess the property name.

- [ ] **Step 2: Run them and watch them fail for the right reason**

Run: `pnpm --filter @docmind/server test -- settings.usecases`

Check each failure, because a test that fails for the wrong reason proves nothing:
- Test 1 fails on `expected false to be true` for the `enc:v1:` prefix, because `setInternal` at line 176 hard codes `isSecret: false` and `JSON.stringify`.
- Test 1 then also fails on `get`, which throws `settings.bad_ciphertext` from `resolveRaw` at line 61, because `resolveRaw` branches on `definition.secret` and hands the JSON string to `decryptSecret`.
- Test 2 fails because `setInternal` calls `parseOrThrow` on null against `v.string()` and throws `settings.invalid_value`.
- Test 3 passes already. That is intended: it is the guard that the fix does not widen the API surface.

- [ ] **Step 3: Fix setInternal**

Replace the body of `setInternal` (`settings.usecases.ts:170-178`) so it mirrors the secret branch of `set()` at lines 135 to 154. The clear branch comes first, before `parseOrThrow`, because null is not a valid value for most schemas:

```ts
    // For other server modules only, never exposed through the API. Bypasses the
    // internal-key rejection in set(). Mirrors the secret handling in set(): a secret
    // definition is encrypted and stored with isSecret true, because resolveRaw decides
    // whether to decrypt from definition.secret and not from the stored column.
    async setInternal(userId: string, key: string, value: unknown) {
      const definition = registry.get(key);
      if (!definition.internal) {
        throw new Error(`setInternal called on non-internal setting "${key}"`);
      }
      if (value === null || (definition.secret && value === "")) {
        await repository.remove({ userId, key });
        cache.delete(userId);
        return;
      }
      const parsed = parseOrThrow(definition, value);
      if (definition.secret) {
        if (typeof parsed !== "string") {
          throw createError({ code: "settings.invalid_value", message: `Secret "${key}" must be a string`, status: 400 });
        }
        await repository.upsert({
          userId,
          key,
          isSecret: true,
          value: encryptSecret({ plaintext: parsed, keyHex: config.settingsEncryptionKey }),
        });
        cache.delete(userId);
        return;
      }
      await repository.upsert({ userId, key, isSecret: false, value: JSON.stringify(parsed) });
      cache.delete(userId);
    },
```

`resolveRaw` needs no change: once the write side is right, the read side already works. No migration is needed because no such row exists on any install. The only two internal settings today are `search.activeDimension`, a number, and `types.presetsSeeded`, a boolean, both non-secret.

- [ ] **Step 4: Run the tests, watch them pass, then run the current callers**

```bash
pnpm --filter @docmind/server test -- settings
pnpm --filter @docmind/server test -- search.usecases
pnpm --filter @docmind/server test -- tags.usecases
```

The last two are the existing `setInternal` callers and this change alters its behaviour for null.

- [ ] **Step 5: Hand check the call sites, because tests are not typechecked**

```bash
grep -rn "setInternal" apps/server/src apps/client/src
```

Confirm every caller passes a non-null value of the right type. `pnpm typecheck` will not catch a test file that got this wrong.

- [ ] **Step 6: Commit**

Commit message, with the body explaining the latent defect:

```
fix(server): encrypt secret internal settings in setInternal

setInternal hard coded isSecret false and JSON stringified the value, so a
setting declared both secret and internal was written to the database in
plaintext and then failed to read back with settings.bad_ciphertext, because
resolveRaw decides whether to decrypt from the definition and not from the
stored column. Latent until now: nothing in the tree combined the two flags.
The Google Drive refresh token is the first setting that does. setInternal now
mirrors the secret branch of set() and gains the same null clear path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

- [ ] **Step 7: Propose the bug record**

Run the `bug-fix-record` agent with the root cause, the regression test and the fix. Wait for explicit approval before it writes anything. Never record without it.

---

### Task 2: Storage contract groundwork, the error vocabulary and a wider contract suite

Pure groundwork. No new driver, no route, no user-visible change. It lands the vocabulary and the tests that tasks 5 and 9 must satisfy.

Read spec decisions 2, 3, 4 and 8b.

**Files:**
- Create: `apps/server/src/modules/storage/storage.errors.ts`, `apps/server/src/modules/storage/storage.errors.test.ts`
- Modify: `apps/server/src/modules/storage/storage.types.ts`
- Modify: `apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts`
- Modify: `apps/server/src/modules/storage/drivers/local/local.driver.ts`

**Interfaces:**
- Produced: `StorageErrorCode`, `storageError()`, and the named helpers `notConfigured`, `authExpired`, `quotaExceeded`, `rateLimited`, `networkError`, `remoteError`, `driverInUse`, `notFound`.
- Produced: `StorageDriverDefinition.requiredSettings: string[]` and `StorageDriverDefinition.oauth?: StorageOauthDefinition`.
- Produced: `runDriverContractTests(name, makeDriver, options?)` where options is `{ largeBodyBytes?: number }`.

- [ ] **Step 1: Write the failing tests**

New file `storage.errors.test.ts`, covering the status mapping for all ten codes, that the provider text ends the message verbatim, and the exact `not_configured` wording:

```ts
  it("maps each code to its documented status", () => {
    expect(storageError({ code: "storage.not_configured", message: "x" }).status).toBe(409);
    expect(storageError({ code: "storage.auth_expired", message: "x" }).status).toBe(401);
    expect(storageError({ code: "storage.quota", message: "x" }).status).toBe(507);
    expect(storageError({ code: "storage.rate_limited", message: "x" }).status).toBe(429);
    expect(storageError({ code: "storage.network", message: "x" }).status).toBe(502);
    expect(storageError({ code: "storage.remote_error", message: "x" }).status).toBe(502);
    expect(storageError({ code: "storage.driver_in_use", message: "x" }).status).toBe(409);
  });

  it("keeps the provider text verbatim at the end of the message", () => {
    const error = authExpired("Google Drive", "invalid_grant: Token has been expired or revoked.");
    expect(error.message.endsWith("invalid_grant: Token has been expired or revoked.")).toBe(true);
  });

  it("names the missing settings in a not_configured message", () => {
    expect(notConfigured("Google Drive", ["client ID", "client secret", "connection"]).message).toBe(
      "Google Drive is not fully configured. Missing: client ID, client secret, connection.",
    );
  });
```

The remaining three codes, `storage.not_found` 404, `storage.invalid_key` 400 and `storage.unknown_driver` 400, already exist in the code and keep their current statuses; assert them too so the table cannot drift.

In `driver-contract.test-utils.ts`, change the signature and add four tests. Write them so they pass against the local driver unchanged: that is the proof the suite encodes the interface and not S3 or Drive semantics.

```ts
export function runDriverContractTests(
  name: string,
  makeDriver: () => Promise<StorageDriver>,
  { largeBodyBytes = 8 * 1024 * 1024 }: { largeBodyBytes?: number } = {},
) {
```

The four new cases, added inside the existing describe:

1. **The returned key is authoritative.** Put with a requested key, then `exists`, `get` and `delete` using only the returned key. Assert the round trip and assert nothing about the returned key equalling the requested one. Comment it: the requested key is a naming hint, local returns it, S3 returns it prefixed, Drive returns a file id.
2. **Delete is idempotent.** Delete a never-written key, then put, delete, and delete again. None of the three throws. Comment it: the upload path calls delete on both the oversize branch and the duplicate branch, so a throw here turns a duplicate upload into a 500.
3. **A binary body round trips byte for byte,** including bytes above 0x7f, so a driver that quietly does a utf8 conversion fails here. This needs a `readAllBuffer` helper beside the existing `readAll` at line 6, because `readAll` stringifies as utf8 and would hide exactly the bug being hunted.
4. **A key whose last segment has spaces, dots and non-ASCII characters round trips.** Use a real multi-byte character in the key.

Then change the large body test at lines 35 to 51 so the loop count and the assertion derive from `largeBodyBytes` instead of the hard coded 8, keeping the 1 MiB chunk:

```ts
      const chunkSize = 1024 * 1024;
      const chunks = Math.max(1, Math.ceil(largeBodyBytes / chunkSize));
      // push `chunks` chunks, then assert the read back size is chunks * chunkSize
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- storage`

Expected: `storage.errors.test.ts` cannot resolve `./storage.errors.js`. The four new contract tests run against local and three should already pass. If the non-ASCII one fails, that is information: decide whether the local driver or the test is wrong, fix the test unless the driver is genuinely broken, and record what you found in the commit body.

- [ ] **Step 3: Write storage.errors.ts**

One `STORAGE_ERROR_STATUS` record mapping each of the ten codes to its status, taken from the table in spec decision 4. One `storageError({ code, message })` built on `createError` from `../../shared/errors/errors.js`, filling the status from that record. Then the named helpers, each taking the driver label and the raw provider text, putting the provider text last and unedited.

File header comment: the provider text is appended verbatim because that is what makes a misconfiguration diagnosable, and no helper ever receives or prints a credential.

- [ ] **Step 4: Widen StorageDriverDefinition**

In `storage.types.ts`, add `requiredSettings: string[]` and `oauth?: StorageOauthDefinition` to `StorageDriverDefinition` (lines 17 to 23), and add the `StorageOauthDefinition` type exactly as written in spec decision 2, keeping both spec comments.

`requiredSettings` is required, not optional, so the compiler names every driver definition that has not been updated. There is exactly one today.

- [ ] **Step 5: Update the local driver**

In `local.driver.ts`, add `requiredSettings: [],` to `localDriverDefinition` (starts at line 77), right after `settings: [localRootSetting],`. That single line is the only change to that file in this entire plan.

- [ ] **Step 6: Hand check the contract suite call sites**

```bash
grep -rn "runDriverContractTests" apps/server/src
```

Today there is one caller, `local.driver.test.ts:20`. `largeBodyBytes` is optional with a default so that caller needs no edit, but verify by reading, not by trusting the compiler: `local.driver.test.ts` matches the test exclude in `apps/server/tsconfig.json` and is never compiled.

- [ ] **Step 7: Run and commit**

```bash
pnpm --filter @docmind/server test -- storage
pnpm --filter @docmind/server test -- local.driver
pnpm typecheck
```

Commit message:

```
feat(server): storage error vocabulary and a wider driver contract suite

Adds storage.errors.ts with the ten mapped codes, gives StorageDriverDefinition
requiredSettings and an optional oauth block, and turns three implied contract
rules into tests: the returned key is authoritative, delete is idempotent, and
keys are opaque strings rather than paths. The contract suite gains a
largeBodyBytes option so a driver can be run a second time with a body sized
against its own chunking.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 3: Documents and export survive an unreachable driver

This item creates the conditions under which the driver of a document can stop being configured, so this item fixes the two places that break under it. Read spec section 5, "The honest behaviour when a document driver is no longer usable".

**Files:**
- Modify: `apps/server/src/modules/documents/documents.repository.ts`
- Modify: `apps/server/src/modules/documents/documents.usecases.ts`
- Modify: `apps/server/src/modules/export/export.usecases.ts`
- Test: `apps/server/src/modules/documents/documents.usecases.test.ts`, and `apps/server/src/modules/export/export.usecases.test.ts` (create it if absent)

**Interfaces:**
- Produced: `documentsRepository.countByDriver({ userId })` returning `Array<{ storageDriver: string; count: number }>`, and `documentsService.countByDriver({ userId })` wrapping it. Task 4 consumes this.
- Produced: `createDocumentsService` and `createExportService` each gain an injectable `logger` with a `createLogger(...)` default, matching the convention at `chat.usecases.ts:55`, `tags.usecases.ts:79` and `rules.usecases.ts:38`.
- Changed behaviour: `purge()` no longer throws when the driver cannot be constructed or the blob cannot be deleted.

**Why the try/catch must wrap getDriver and not only driver.delete.** In `documents.usecases.ts`, `purge()` begins at line 167 (search for `async purge({ userId, documentId }`). Line 170 is `const driver = await storageService.getDriver(userId, document.storageDriver);` and line 171 is `await driver.delete({ key: document.storageKey });`. `getDriver` calls `definition.create` (`storage.usecases.ts:31`), and `create` is what throws `storage.not_configured` for a driver with no credentials. So the throw happens at line 170 and line 171 is never reached. A catch around the delete alone fixes nothing.

Do not confuse this with `remove()` at line 154, the soft delete behind `DELETE /api/documents/:id`. It only writes `deletedAt`, never touches storage, and must not change. Moving a document to trash always works and there is a test below to keep it that way.

- [ ] **Step 1: Write the failing tests**

In `documents.usecases.test.ts`, add a storage service that cannot construct a driver:

```ts
function brokenStorage(): StorageService {
  const fail = async () => {
    throw createError({ code: "storage.not_configured", message: "Google Drive is not connected", status: 409 });
  };
  return { getDriver: fail, getActiveDriverId: async () => "local", getActiveDriver: fail } as unknown as StorageService;
}
```

Then three tests:

```ts
  it("purges a document whose driver cannot be constructed, and logs a warning", async () => {
    const { document } = await documents.upload({ userId, name: "gone.txt", body: Readable.from(["x"]) });
    const warnings: unknown[] = [];
    const stubLogger = { info: () => {}, warn: (obj: unknown) => warnings.push(obj), error: () => {}, debug: () => {} };
    const broken = createDocumentsService({ db, storageService: brokenStorage(), logger: stubLogger as never });
    await broken.remove({ userId, documentId: document.id });
    await broken.purge({ userId, documentId: document.id });
    await expectAppError(() => documents.get({ userId, documentId: document.id }), "documents.not_found");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ documentId: document.id, storageDriver: "local" });
  });

  it("moves a document to trash without ever asking for a storage driver", async () => {
    // remove() is the soft delete. The cheapest proof that an unreachable driver cannot
    // break it is that it never calls getDriver at all.
    let getDriverCalls = 0;
    const counting = {
      getDriver: async (u: string, d: string) => { getDriverCalls += 1; return storageService.getDriver(u, d); },
      getActiveDriverId: (u: string) => storageService.getActiveDriverId(u),
      getActiveDriver: (u: string) => storageService.getActiveDriver(u),
    } as unknown as StorageService;
    const svc = createDocumentsService({ db, storageService: counting });
    const { document } = await svc.upload({ userId, name: "soft.txt", body: Readable.from(["x"]) });
    const afterUpload = getDriverCalls;
    await svc.remove({ userId, documentId: document.id });
    expect(getDriverCalls).toBe(afterUpload);
  });

  it("counts documents per driver, including trashed ones", async () => {
    const a = await documents.upload({ userId, name: "a.txt", body: Readable.from(["a"]) });
    await documents.upload({ userId, name: "b.txt", body: Readable.from(["b"]) });
    await documents.remove({ userId, documentId: a.document.id });
    expect(await documents.countByDriver({ userId })).toEqual([{ storageDriver: "local", count: 2 }]);
  });
```

The third test pins a decision: `countByDriver` counts trashed documents, because a trashed document still has a blob on the driver, and the "Holds N documents" line on the Storage tab is about blobs, not about the library view.

In `export.usecases.test.ts`, add:

```ts
  it("records a document it could not read in the manifest instead of silently omitting it", async () => {
    // Upload through the real storage service, then export through one whose getDriver
    // throws. Assert metadata.json parses, has skippedFiles with the document id, name,
    // driver and reason, and that files/<id>/<name> is absent from the zip.
  });
```

Write it out fully against the real harness. If that test file does not exist, create it and model the setup on the `beforeEach` at `documents.usecases.test.ts:24-33`.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @docmind/server test -- documents.usecases
pnpm --filter @docmind/server test -- export
```

Expected: the purge test fails with `storage.not_configured` escaping out of `purge`, the count test fails with `countByDriver is not a function`, and the export test fails on `skippedFiles` being undefined. The `remove()` test should pass already. It is the regression guard that keeps the purge fix from being applied to the wrong function.

- [ ] **Step 3: Add countByDriver to the repository**

In `documents.repository.ts`, beside `countByUser` (line 171), one grouped Drizzle select. No raw SQL beyond the count aggregate that `countByUser` already uses:

```ts
    async countByDriver({ userId }: { userId: string }): Promise<Array<{ storageDriver: string; count: number }>> {
      return db
        .select({ storageDriver: documentsTable.storageDriver, count: sql<number>`count(*)`.mapWith(Number) })
        .from(documentsTable)
        .where(eq(documentsTable.userId, userId))
        .groupBy(documentsTable.storageDriver);
    },
```

Expose it on the service as `countByDriver({ userId })` delegating straight to the repository.

- [ ] **Step 4: Fix purge**

Add the injectable logger to `createDocumentsService` (signature at lines 16 to 24) and import `createLogger` from `../../shared/logger/logger.js`. Then:

```ts
    async purge({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await repository.findById({ userId, documentId });
      if (!document) throw notFound(documentId);
      // Both calls are inside the try on purpose. getDriver is what throws when a driver
      // has no credentials, because it constructs the driver, so a catch around the
      // delete alone would never fire. An orphaned blob on an unreachable remote is the
      // lesser evil against a document the user can never delete.
      try {
        const driver = await storageService.getDriver(userId, document.storageDriver);
        await driver.delete({ key: document.storageKey });
      } catch (error) {
        logger.warn(
          { documentId, storageDriver: document.storageDriver, storageKey: document.storageKey, err: (error as Error).message },
          "Permanent delete could not remove the stored file, the row is removed anyway",
        );
      }
      await repository.remove({ userId, documentId });
    },
```

- [ ] **Step 5: Record export skips in the manifest**

In `export.usecases.ts` the bare `catch { }` at lines 47 to 49 captures neither the document nor the error. Three changes:

1. Declare `const skipped: Array<{ documentId: string; name: string; storageDriver: string; reason: string }> = [];` before the loop at line 39.
2. Replace the bare catch with `catch (error)` that pushes the document id, name, driver and `(error as Error).message` onto `skipped` and logs a warning.
3. **Move the `zip.file("metadata.json", ...)` call from line 37 to after the loop**, and add `skippedFiles: skipped` to the `metadata` object. This is the subtle part: today the manifest is written before any file is read, so it physically cannot mention a skip. Leave a one line comment saying the manifest is written last because it reports on the loop.

`createExportService` gains the injectable logger the same way, so its call site at `server.ts:187` must be read and confirmed.

- [ ] **Step 6: Hand check the changed signatures**

```bash
grep -rn "createDocumentsService(" apps/server/src
grep -rn "createExportService(" apps/server/src
```

Both gain an optional parameter with a default, so no call site must change, but confirm by reading. `pnpm typecheck` covers `server.ts` and misses every test file.

- [ ] **Step 7: Run the whole server suite, then commit**

```bash
pnpm --filter @docmind/server test
pnpm typecheck
```

Commit message:

```
fix(server): permanently delete and export documents whose driver is unreachable

purge() constructed the storage driver before deleting the blob, and driver
construction is what throws for a driver with no credentials, so a document on
a disconnected driver could never be permanently deleted. The try/catch now
wraps getDriver as well as driver.delete and logs a warning with the document
id, driver and key. remove(), the soft delete, is unchanged and has a test
proving it never asks for a driver at all. The export manifest is written after
the file loop so it can list the documents it could not read, and
documents.countByDriver lands for the storage status route.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 4: Storage status, test connection, the unconfigured driver guard, and the design doc amendment

After this task the local driver has an API behind a Test button and the settings guard that every later task depends on. Only the local driver exists, so there is little to see, which is exactly why this lands before any new driver: the guard gets tested against fakes rather than against a half-built S3 driver.

Read spec decisions 12, 14 and 15, and spec section 6.

**Files:**
- Modify: `apps/server/src/modules/storage/storage.usecases.ts`
- Create: `apps/server/src/modules/storage/storage.schemas.ts`
- Create: `apps/server/src/modules/storage/storage.routes.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `DOCMIND-DESIGN.md`
- Test: `apps/server/src/modules/storage/storage.usecases.test.ts`, new `apps/server/src/modules/storage/storage.routes.test.ts`

**Interfaces:**
- Consumed: `documentsService.countByDriver` from task 3, the helpers from `storage.errors.ts` from task 2.
- Produced: `createStorageService({ settingsService, registry?, countDocumentsByDriver? })`, plus `listDriverStatus(userId)`, `testDriver(userId, driverId)`, `recordAuthError(driverId, message)`, `clearAuthError(driverId)`, and the exported `assertStorageUpdatesValid({ userId, updates, settingsService, storageService })`.
- Produced: `GET /api/storage/drivers`, `POST /api/storage/drivers/:id/test`, `POST /api/storage/drivers/:id/disconnect`.

**Why the registry becomes injectable.** `storageDriverRegistry` is a compiled in module constant, so a route test cannot script a failing health check against it. Adding `registry = storageDriverRegistry` as a defaulted constructor parameter makes both `testDriver` and `assertStorageUpdatesValid` testable with two or three fake definitions, and costs one line of production code.

- [ ] **Step 1: Fix an existing test that a later task will otherwise break**

`storage.usecases.test.ts`, the last line of `it("resolves the active driver from settings")`:

```ts
    await expectAppError(() => storage.getDriver("u1", "s3"), "storage.unknown_driver");
```

`s3` becomes a real driver id in task 5 and this assertion then fails. Change the id to one that will never exist:

```ts
    await expectAppError(() => storage.getDriver("u1", "dropbox"), "storage.unknown_driver");
```

Do it now, in this task, while it is a one line edit and not a mysterious red test in the middle of the S3 work.

- [ ] **Step 2: Write the failing tests**

Add to `storage.usecases.test.ts`, all against a fake registry of two or three definitions so the assertions do not move when a real driver lands:

```ts
  it("reports a driver as unconfigured and names the missing settings as human labels", ...);
  it("reports the document count per driver", ...);
  it("allows a batch that sets the credentials and switches the active driver together", ...);
  it("rejects a switch to a driver whose required settings are missing", ...);   // storage.not_configured, 409
  it("rejects clearing a required credential of the active driver", ...);        // storage.driver_in_use, 409
  it("allows clearing a required credential of a driver that is not active, even when it holds documents", ...);
  it("records and clears the last auth error per driver", ...);
  it("turns a setting key into a human label", ...);  // storage.s3.secretAccessKey -> secret access key
```

New file `storage.routes.test.ts`, integration style against in-memory SQLite, modelled on the `makeApp()` helper at `settings.routes.test.ts:10-21`:

```ts
  it("GET /api/storage/drivers returns every driver with its guide, configured flag and document count", ...);
  it("POST /api/storage/drivers/:id/test returns 200 with ok true for a healthy driver", ...);
  it("POST /api/storage/drivers/:id/test returns 200 with ok false and the provider message for a failing driver", ...);
  it("POST /api/storage/drivers/:id/test rejects an unknown driver id with 400", ...);
  it("never returns a secret value in the driver status payload", ...);
```

The last one matters. Assert on `await res.text()` not containing the secret, the same way `settings.routes.test.ts` does in its "updates values and never echoes a secret" test. A status route that assembles configuration is exactly where a secret leaks by accident.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- storage`
Expected: `listDriverStatus is not a function`, and the routes test failing to resolve `./storage.routes.js`.

- [ ] **Step 4: Extend storage.usecases.ts**

Keep `buildStorageKey` and the three existing methods exactly as they are. Add the injectable registry and the count callback to `createStorageService`, then:

- A module level `const lastAuthError = new Map<string, { at: string; message: string }>()` with `recordAuthError` and `clearAuthError`. Comment it as spec decision 15 states: in memory on purpose, reset on restart, never a settings write on an auth failure, and a refresh token is never deleted automatically.
- `listDriverStatus(userId)` returning the shape in spec section 6 under "Companion route": `activeDriverId` plus one entry per driver with `id`, `label`, `guide`, `configured`, `missingSettings`, `documentCount`, `requiresOauth`, optional `redirectUri` and optional `connection`. Until task 10 lands, `connection` can be omitted and `requiresOauth` is false for every driver.
- `missingSettings` holds human labels, not keys. Derive each from the last dot segment of the setting key, splitting camelCase into words, so `storage.s3.secretAccessKey` becomes `secret access key`. Put that conversion in a small exported pure function in `storage.usecases.ts` or, better, in a new `storage.models.ts` if it grows past a few lines, since pure logic belongs in models.
- `testDriver(userId, driverId)` returning `{ ok, latencyMs, message }`, measured around the whole check, catching every throw into `{ ok: false, message }` rather than letting it escape. On a caught `storage.auth_expired` it calls `recordAuthError`; on success it calls `clearAuthError`. The shape is identical to the AI module TestResult on purpose (`ai.usecases.ts:293-300`), so the client can share one component.
- `assertStorageUpdatesValid` exported as a standalone function, so `server.ts` stays thin and the rules are testable outside the server wiring. Implement the three rules in spec decision 12, and consult `updates` before the stored value exactly as the AI branch already does at `server.ts:96-102`, carrying the same comment about a single PUT setting the key and the slot together.

- [ ] **Step 5: Write storage.schemas.ts and storage.routes.ts**

`storage.schemas.ts` exports `storageDriverIdSchema = v.picklist(storageDriverIds)` and, ready for task 10, `oauthCallbackQuerySchema`. Routes parse the id param with `parseOrValidationError(storageDriverIdSchema, c.req.param("id"))`, mirroring `ai.routes.ts:81`.

`storage.routes.ts` exports `registerStorageRoutes({ app, storageService, getUserId })` and registers the three routes. The test route returns `c.json(result)` with a 200 even when `ok` is false, so the client renders the message inline rather than as a toast. It throws only for an unknown id or a missing session. Routes never touch Drizzle.

The disconnect route exists separately from `PUT /api/settings` because the refresh token is internal and cannot be cleared through the settings API by design. At this point no driver has an `oauth` block, so it returns `storage.unknown_driver` for every id. Write the route now and let task 10 fill in the body.

- [ ] **Step 6: Wire server.ts**

At line 146, pass the count callback:

```ts
  const storageService = createStorageService({
    settingsService,
    countDocumentsByDriver: (userId) => documentsService.countByDriver({ userId }),
  });
```

`documentsService` is declared three lines below at line 149. This is legal because the reference sits inside an arrow function body that is not called until a request arrives, so there is no temporal dead zone at module evaluation. If the compiler objects, move `const documentsRepository = createDocumentsRepository({ db })` above the storage service and call the repository directly.

In the `beforeSet` hook (lines 85 to 143), after the existing `ai.model.` loop closes, add one call:

```ts
        await assertStorageUpdatesValid({ userId, updates, settingsService, storageService });
```

Register the routes after the session middleware, beside the other feature routes from line 175 onwards:

```ts
  registerStorageRoutes({ app, storageService, getUserId });
```

- [ ] **Step 7: Amend DOCMIND-DESIGN.md, because this is the commit where the rule changes**

This is a required step of this task and not a documentation footnote swept into task 11. From this commit onwards the server enforces something the design document contradicts, and a contradiction between the spec and the code is exactly what gets re-implemented wrongly six months later.

In `DOCMIND-DESIGN.md`, the paragraph headed `**Switching drivers.**` at lines 335 to 338 currently ends with:

> The UI shows how many documents each driver holds and refuses to clear credentials for a driver that holds any.

Replace that sentence so the paragraph reads:

> **Switching drivers.** Each document row records its driver. Changing the active driver
> affects new uploads only. Reads resolve the driver from the row. The UI shows how many
> documents each driver holds. Clearing the credentials of the active driver is refused,
> because that breaks the next upload and the fix is one click: switch the active driver
> first. Clearing the credentials of an inactive driver is allowed behind a confirmation
> that names the document count, even when it still holds documents. Those documents stay
> in the library, stay searchable and stay citable in chat; only download and preview stop
> working, and they work again the moment the credential is entered again. A blanket
> refusal would trap the user forever after a single upload. A move-documents job is a
> later item.

Ruled by the user on 2026-09-18. Do not revert it without asking them.

- [ ] **Step 8: Run everything and commit**

```bash
pnpm --filter @docmind/server test
pnpm typecheck
```

Commit message:

```
feat(server): storage driver status, test connection, and the unconfigured driver guard

Adds GET /api/storage/drivers, POST /api/storage/drivers/:id/test and
POST /api/storage/drivers/:id/disconnect, an in memory lastAuthError per driver,
and assertStorageUpdatesValid wired into the settings beforeSet hook. Switching
to a driver whose required settings are missing is a 409 that names what is
missing, consulting pending updates in the same batch so one PUT can set the
credentials and the driver together. Clearing a required credential is refused
for the active driver and allowed for an inactive one, and DOCMIND-DESIGN.md is
amended to match, replacing the blanket refusal that trapped the user after a
single upload.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 5: The S3 compatible driver

Read spec section 3 and decisions 9, 10, 11 and 16.

**Files:**
- Create: `apps/server/src/modules/storage/drivers/s3/s3.models.ts`, `s3.guide.ts`, `s3.driver.ts`, `s3.models.test.ts`, `s3.driver.test.ts`
- Modify: `apps/server/src/modules/storage/storage.registry.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumed: `storage.errors.ts`, `runDriverContractTests`, `defineSetting`, `StorageDriverDefinition`.
- Produced: `createS3Driver({ config, clientFactory? })`, `s3DriverDefinition`, and the pure helpers `joinPrefix`, `normalizeEndpoint`, `buildS3ClientConfig`, `mapS3Error`.

**New dependencies, this task only:**

```bash
pnpm --filter @docmind/server add @aws-sdk/client-s3 @aws-sdk/lib-storage
```

`lib-storage` earns its place: its `Upload` takes a `Readable` of unknown length, does multipart automatically, and issues AbortMultipartUpload when the stream errors. The upload path streams the body before the size is known, so a plain PutObject with a Content-Length is not available.

- [ ] **Step 1: Write the failing tests**

`s3.models.test.ts`, all pure, no client constructed:

```ts
  it("joins a prefix and a key with exactly one slash and no leading slash", ...);
  it("treats an empty prefix as no prefix", ...);
  it("normalizes a trailing slash and a missing scheme on the endpoint", ...);
  it("builds a client config with virtual host addressing by default", ...);
  it("builds a client config with forcePathStyle when the setting is on", ...);
  it("sets requestChecksumCalculation and responseChecksumValidation to WHEN_REQUIRED", ...);
  it("maps InvalidAccessKeyId and SignatureDoesNotMatch to storage.auth_expired", ...);
  it("maps NoSuchBucket and AccessDenied to storage.not_configured", ...);
  it("maps NoSuchKey and a 404 to storage.not_found", ...);
  it("maps SlowDown and a 503 to storage.rate_limited", ...);
  it("maps ENOTFOUND to storage.network and appends the path style hint", ...);
  it("maps anything else to storage.remote_error with the provider text at the end", ...);
```

Feed `mapS3Error` an SDK shaped object, `{ name, message, $metadata: { httpStatusCode } }`, because that is what the SDK actually throws and a hand-rolled `Error` would prove nothing.

`s3.driver.test.ts` runs the shared contract suite against a real MinIO, gated on `S3_TEST_ENDPOINT`. When the variable is absent, use `describe.skip` and print a note naming the variable, so the gate is discoverable rather than invisible:

```ts
const endpoint = process.env.S3_TEST_ENDPOINT;
const suite = endpoint ? describe : describe.skip;
if (!endpoint) console.log("S3 contract suite skipped. Set S3_TEST_ENDPOINT to run it against MinIO.");
```

A throwaway MinIO for that run:

```bash
docker run --rm -p 9000:9000 -e MINIO_ROOT_USER=docmind -e MINIO_ROOT_PASSWORD=docmind123 \
  quay.io/minio/minio server /data
# then, with the bucket created:
# S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=docmind-test \
# S3_TEST_ACCESS_KEY_ID=docmind S3_TEST_SECRET_ACCESS_KEY=docmind123 S3_TEST_FORCE_PATH_STYLE=1 \
# pnpm --filter @docmind/server test -- s3.driver
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- s3`
Expected: cannot resolve `./s3.models.js`, and the contract suite skipped with the printed note.

- [ ] **Step 3: Write s3.models.ts**

Pure only, no IO, no SDK client construction. `buildS3ClientConfig` returns a plain object that the driver hands to `new S3Client(...)`, which is what makes it assertable in a unit test. It must include, with a comment saying why:

```ts
  // Recent AWS SDK versions send a CRC32 checksum header and an
  // x-amz-sdk-checksum-algorithm header on every upload and validate response
  // checksums. R2, B2 and older MinIO builds reject or mishandle those, which surfaces
  // as an opaque 400 or a signature error. This is the single most likely cause of
  // "works on AWS, fails on my MinIO".
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  maxAttempts: 4,
  requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 },
```

`mapS3Error(error, { driverLabel, endpoint, forcePathStyle })` returns an `AppError` from `storage.errors.ts`. The path style hint is appended only for a DNS failure against a non-empty endpoint with `forcePathStyle` false, because a raw ENOTFOUND on `bucket.host` does not point at the cause.

- [ ] **Step 4: Write s3.guide.ts**

A `SetupGuide` naming AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi and DigitalOcean Spaces, each with its endpoint pattern, its region value, and its path style answer. Include the copyable lifecycle rule that aborts incomplete multipart uploads after 7 days, because a hard process crash can strand parts that cost money silently and DocMind cannot clean them up afterwards.

- [ ] **Step 5: Write s3.driver.ts**

`createS3Driver({ config, clientFactory = (c) => new S3Client(c) })`. The injected factory is decision 16 and is what lets a future test script the client without a network.

- `put`: `new Upload({ client, params: { Bucket, Key: joinPrefix(prefix, key), Body: body, ContentType: mimeType } })`, awaited, returning `{ key: fullKey }`. The returned key includes the prefix, so the document row records it and a later prefix change cannot break an existing document.
- `get`: GetObject, return `response.Body as Readable`. A missing key maps to `storage.not_found`.
- `delete`: DeleteObject, which is already idempotent on S3. Catch and swallow a NoSuchKey anyway so the contract holds on every vendor.
- `exists`: HeadObject, false on 404 or NotFound.
- `healthCheck`: the three steps in spec section 6 under "What the test does per driver". HeadBucket, falling back to ListObjectsV2 with `MaxKeys: 1` on a 403, because a Backblaze application key scoped to one bucket and some least-privilege IAM policies deny HeadBucket while allowing everything DocMind needs. Then PutObject of a nine byte probe at the prefixed `.docmind-health`, GetObject it, DeleteObject it. The probe write is the point: HeadBucket passing while PutObject is denied is the most common S3 misconfiguration. The success message names bucket, region, endpoint and addressing mode so a mismatch is visible at a glance.

The seven settings are declared with `defineSetting` in this file, exactly as the table in spec section 4 lists them, including `accessKeyId` staying non-secret on purpose. `requiredSettings` is the four key list from that section.

- [ ] **Step 6: Register the driver**

Add `s3: s3DriverDefinition` to `storageDriverRegistry` in `storage.registry.ts`. Two things happen for free and both are intended: `activeDriverSetting` at `storage.settings.ts:5` is `v.picklist(storageDriverIds)` so `STORAGE_DRIVER=s3` becomes valid, and `storageSettingDefinitions` at line 13 flatMaps every driver so the seven new keys join the registry with no extra wiring.

- [ ] **Step 7: Run everything**

```bash
pnpm --filter @docmind/server test
pnpm typecheck
```

If `storage.usecases.test.ts` fails on an unknown driver assertion, step 1 of task 4 was skipped. Fix it there, not here.

- [ ] **Step 8: Commit**

```
feat(server): S3 compatible storage driver

Adds the S3 driver over @aws-sdk/client-s3 and @aws-sdk/lib-storage, with pure
prefix, endpoint, client config and error mapping helpers under s3.models.ts.
Checksum calculation and validation are set to WHEN_REQUIRED because the newer
SDK defaults break R2, B2 and older MinIO. Path style addressing is an explicit
boolean rather than inferred from the endpoint. The health check writes, reads
and deletes a probe object, because HeadBucket proves nothing about write
access. The shared contract suite runs against a local MinIO when
S3_TEST_ENDPOINT is set.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

**Note for whoever reviews the commit between task 5 and task 6, so this does not get read as a regression.** For this one commit the S3 driver is configurable only through the existing generic settings loop. `StorageTab.tsx` renders every `storage.*` key as `String(setting.value)` in a plain text input, so `storage.s3.forcePathStyle` shows as the text `false` rather than a checkbox, and there is no active driver selector. That is the current tab behaving exactly as written at `StorageTab.tsx:18-33`, not a regression introduced here. Secrets are still masked server side by `listResolved`, and the server side guard from task 4 still refuses a switch to a half-configured driver. Task 6 replaces the whole tab.

---

### Task 6: Client, the shared setup guide component and the new Storage tab

After this task S3 is usable end to end from the UI. Read spec section 4, "UI behaviour for a selected but unconfigured driver", and "The confirm dialog copy".

**Files:**
- Create: `apps/client/src/pages/settings/SetupGuide.tsx`, `StorageDriverCard.tsx`, `StorageDriverCard.test.tsx`, `apps/client/src/lib/storage-api.ts`
- Modify: `apps/client/src/pages/settings/ProviderCard.tsx`
- Rewrite: `apps/client/src/pages/settings/StorageTab.tsx`, `StorageTab.test.tsx`

**Interfaces:**
- Consumed: `GET /api/storage/drivers` and `POST /api/storage/drivers/:id/test` from task 4, `settingsApi.update` for every non-internal driver setting.
- Produced: `storageApi.listDrivers()`, `storageApi.test(id)`, `storageApi.disconnect(id)`, and a `SetupGuide` component taking `{ guide }`.

- [ ] **Step 1: Write the failing tests**

`StorageTab.test.tsx` is rewritten, not extended. The current single test at lines 21 to 34 drives the generic key and value loop that this task deletes, so keeping it would mean keeping the loop.

```tsx
  it("renders one card per driver with its label and guide", ...);
  it("disables the radio option for an unconfigured driver and names what is missing", ...);
  it("shows the document count on a driver that holds documents", ...);
  it("shows a red banner when the active driver is not configured", ...);
  it("switches the active driver and invalidates the settings query", ...);
```

`StorageDriverCard.test.tsx`:

```tsx
  it("runs the test connection and shows the message inline on failure", ...);
  it("never prefills a secret and offers Replace instead", ...);
  it("asks for confirmation before clearing a credential, and names the document count", ...);
  it("says document rather than documents when the count is 1", ...);
  it("drops the count sentence entirely when the driver holds nothing", ...);
```

The singular and plural test exists because the copy is specified in the spec down to that detail and it is the only thing between the user and a document they cannot open. The exact body strings are in spec section 4 under "The confirm dialog copy". Copy them verbatim into the test, so a later rewording has to be deliberate.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/client test -- StorageTab StorageDriverCard`
Expected: cannot resolve `./StorageDriverCard`, and the tab test failing on a missing card.

- [ ] **Step 3: Extract SetupGuide**

Lift the guide block from `ProviderCard.tsx` lines 200 to 237, unchanged in behaviour, into `SetupGuide.tsx` taking `{ guide }: { guide: SetupGuide }`. Replace that block in `ProviderCard.tsx` with the component. Run `pnpm --filter @docmind/client test -- ProviderCard` and confirm the existing provider tests still pass. This is a pure refactor and must be visible as one in the diff.

- [ ] **Step 4: Write storage-api.ts**

The API client is the only place that knows URLs. Types mirror the status payload from task 4 exactly.

- [ ] **Step 5: Write StorageDriverCard.tsx and rewrite StorageTab.tsx**

Per driver card: label, `Holds N documents` whenever N is above zero, the settings fields for that driver rendered from the settings registry rather than hand written per driver, the `SetupGuide` beside them, a Test button sharing the result line component with the AI tab, and a Clear credentials action behind the confirm dialog.

**What replaces the old `String(setting.value)` loop.** The renderer stays generic, per the client rule that settings forms are generated from the registry, but it dispatches on the kind of the setting instead of stringifying everything. A boolean schema gets a checkbox, so `storage.s3.forcePathStyle` stops rendering as the text `false`. A secret gets the masked control, set and ends in 1234, with a Replace action and no prefill. Anything else gets a text input. The server already sends what that needs: `ResolvedSetting.secret` carries the secret flag and the resolved value carries its own type, so nothing new has to cross the wire for this. Do not write a form component per driver; avoiding exactly that is what the registry is for.

Tab level: the active driver control is a list of radio options, one per driver. An option whose `configured` is false is disabled with a line under it reading `Needs: bucket, secret access key` built from `missingSettings`, plus a link that scrolls to that driver card. The server side guard from task 4 is the real enforcement; the disabled option is a convenience, because a required env var can vanish between page load and click.

When the active driver is unconfigured, a red banner at the top of the tab: `Uploads are failing. The active driver, Google Drive, is not connected.` An unconfigured active driver is silently fatal today, which is why the banner is not optional polish.

Secrets follow the client rule: show "set, ends in 1234" and a Replace action, never prefill. No em dashes in any of this copy.

- [ ] **Step 6: Run both suites and commit**

```bash
pnpm --filter @docmind/client test
pnpm typecheck
```

```
feat(client): storage driver cards, active driver selector and setup guides

Rewrites the Storage tab from a flat list of settings keys into one card per
driver with its setup guide, test connection button, document count and
credential clearing confirm. The active driver selector disables an
unconfigured driver and names the settings it still needs, and a red banner
appears when the active driver itself is not configured. The guide block is
extracted from ProviderCard into a shared SetupGuide component.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 7: Google Drive pure models and the in-memory Drive fake

The Drive work is split across three tasks because the chunked resumable upload is the riskiest code in this item, and every byte-range decision inside it is pure. This task writes the pure helpers and the fake, task 8 writes the token cache and the network wrappers, and task 9 writes the driver on top of both. Splitting it this way means the loop in task 9 is written against helpers that already have tests, rather than debugged through a driver and a fake at the same time, and it puts the fake and the loop in different commits and ideally in different hands.

This task adds no driver, no registry entry, no route. It is all testable groundwork.

Read spec decisions 8 and 8b, and spec section 8.

**Files:**
- Create: `apps/server/src/modules/storage/drivers/gdrive/gdrive.models.ts`, `gdrive.models.test.ts`, `gdrive.fetch.test-utils.ts`

**Interfaces produced:**
- `contentRangeHeader({ start, length, total })` where `total` is a number for the final chunk and undefined for every other chunk, producing `bytes 0-262143/*` or `bytes 786432-1048575/1048576`.
- `parseCommittedRange(rangeHeader)` turning the `Range: bytes=0-262143` a 308 carries into the next start offset, and handling an absent header as zero committed bytes.
- `chooseUploadMode({ bufferedBytes, streamEnded, simpleLimitBytes })` returning `simple` or `resumable`.
- `accessTokenExpired({ expiresAt, now, skewMs })` with a 60 second default skew.
- `mapDriveError(payload, status, { driverLabel })` covering `invalid_grant`, `storageQuotaExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`, a plain 404, a 429 and a 5xx.
- `driveFileNameFromKey(key)` returning the last path segment, which is the already sanitized filename.
- `buildAuthorizeUrl({ authorizeUrl, clientId, redirectUri, scopes, state, authorizeParams })`.

- [ ] **Step 1: Write the failing tests**

`gdrive.models.test.ts`, one test per function above, plus these three which are the ones that will actually catch a bug:

```ts
  it("writes a star for the total on every chunk except the last", ...);
  it("writes the real total on the final chunk even when it is a partial chunk", ...);
  it("resumes from the committed byte after a 308, not from zero", ...);
```

Assert the exact header strings. `bytes 0-262143/*` is not the same as `bytes 0-262144/*` and an off by one here is a corrupted upload that no type checker will catch.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- gdrive.models`
Expected: cannot resolve `./gdrive.models.js`.

- [ ] **Step 3: Write gdrive.models.ts**

Pure functions only. No fetch, no settings service, no imports from anything except `storage.errors.js` and valibot.

- [ ] **Step 4: Write the in-memory Drive fake**

`gdrive.fetch.test-utils.ts` exports `createDriveFetchFake(options?)` returning `{ fetchImpl, files, requests }`. It implements, in memory: the token endpoint (refresh and code exchange), `files.create` with `uploadType=resumable` returning a session URL in the `Location` header, chunk PUTs to that session URL with range bookkeeping returning 308 until the final chunk, `files.create` with `uploadType=multipart`, `files.get` with `alt=media`, `files.get` metadata, `files.list`, `files.delete`, and `about.get`.

It also needs scripted failures, because tests in tasks 8 and 9 depend on them: `failOnce({ chunkIndex, status })` for the mid-transfer 5xx, and a switch to make the token endpoint return `invalid_grant`.

`requests` records every call so a test can assert how many PUTs happened. That is how the small chunk run proves it took more than one PUT rather than merely asserting the bytes came back.

Note this file is a `*.test-utils.ts`, so unlike a `*.test.ts` it **is** typechecked. Getting a type wrong here fails the build, which is a feature.

- [ ] **Step 5: Test the fake against itself**

Add a short `describe` in `gdrive.models.test.ts` or a dedicated file that drives the fake directly: open a resumable session, PUT three chunks, read the bytes back, and assert the fake returned 308, 308, 200 in that order. A fake with a bug in it produces a green suite and a broken driver, so the fake gets its own test before anything relies on it.

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter @docmind/server test -- gdrive
pnpm typecheck
```

```
feat(server): Google Drive pure helpers and an in-memory Drive fake

Lands the byte-range, upload-mode, token-expiry, error-mapping and authorize-URL
helpers for the Drive driver as pure functions with unit tests, plus a fetch
fake that implements the Drive endpoints the driver needs, including resumable
session bookkeeping and scripted failures. No driver and no registry entry yet:
the chunking loop is the riskiest code in this item and it is written in
task 9, against helpers and wrappers that already have tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 8: Google Drive token cache and API wrappers

The Drive work is split across three tasks, not two, because the resumable upload is the riskiest code in this item and because a single agent writing the fake, the wrappers and the chunking loop in one sitting produces three artefacts that agree with each other and possibly with nothing else. Task 7 wrote the pure helpers and the fake. This task writes every network call and its retry, timeout and error behaviour, exercised against that fake. Task 9 writes the streaming loop and the driver surface on top, and nothing else.

Read spec decisions 5 and 8, and the spec subsection "Token storage and refresh".

**Files:**
- Create: `apps/server/src/modules/storage/drivers/gdrive/gdrive.tokens.ts`, `gdrive.api.ts`, `gdrive.tokens.test.ts`, `gdrive.api.test.ts`

**Interfaces:**
- Consumed: `gdrive.models.ts` and `createDriveFetchFake` from task 7, `storage.errors.ts` from task 2, `settingsService.get` for the refresh token.
- Produced: `getAccessToken({ settings, userId, fetchImpl })` from `gdrive.tokens.ts`.
- Produced from `gdrive.api.ts`, every function taking the injected `fetchImpl` and an access token: `refreshAccessToken`, `createResumableSession`, `putChunk`, `queryCommittedRange`, `uploadSimple`, `getFileMedia`, `getFileMetadata`, `listFiles`, `deleteFile`, `getAbout`, `resolveOrCreateFolder`.

`resolveOrCreateFolder` lives here rather than in the driver because it is two plain metadata calls, files.get then files.create, and putting it here means the folder recreation fallback gets its own test against the fake instead of riding along inside the upload path.

- [ ] **Step 1: Write the failing tests**

`gdrive.tokens.test.ts`:

```ts
  it("exchanges the refresh token once and caches the access token", ...);
  it("refreshes the access token once for two concurrent calls", ...);   // one in-flight promise
  it("refreshes when within 60 seconds of expiry and not before", ...);
  it("discards the cached token when the refresh token changes", ...);   // fingerprint
  it("never writes the access token to the settings table", ...);        // assert debugRows
  it("maps invalid_grant to storage.auth_expired", ...);
```

The last two are the ones worth having. The access token is in process memory only by decision 5, and the cheapest proof is that no row appears.

`gdrive.api.test.ts`, all against `createDriveFetchFake`:

```ts
  it("opens a resumable session and returns the session URL from the Location header", ...);
  it("returns continue with the committed byte for a 308 and done for a 200", ...);
  it("queries the session for the committed range after a 5xx", ...);
  it("uploads a small body in one multipart request", ...);
  it("streams file media back", ...);
  it("retries a 429 three times with backoff and then throws storage.rate_limited", ...);
  it("retries a 403 rateLimitExceeded the same way", ...);
  it("maps storageQuotaExceeded to storage.quota", ...);
  it("surfaces a 404 from deleteFile rather than swallowing it", ...);   // the driver swallows, not this layer
  it("creates the folder when files.get reports it missing or trashed", ...);
  it("creates the folder when files.get reports it trashed", ...);
```

The delete test pins a layering decision: `gdrive.api.ts` reports what Drive said, and the driver is the layer that turns a 404 into the idempotent delete the contract requires. Putting the swallow down here would hide a genuine 404 from `exists` too.

Inject a fake clock or a zero backoff into the retry helper so the rate limit tests do not actually sleep for seven seconds.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- gdrive.tokens gdrive.api`
Expected: cannot resolve `./gdrive.tokens.js` and `./gdrive.api.js`.

- [ ] **Step 3: Write gdrive.tokens.ts**

A module scoped cache keyed by user id holding `{ accessToken, expiresAt, refreshTokenFingerprint }`. This is not an optimisation, it is required: `storageService.getDriver` calls `definition.create` on **every** request (`storage.usecases.ts:31`), so a cache held on the driver instance would mean a token exchange per download. The fingerprint is a short hash of the refresh token, so reconnecting with a different account invalidates the cache immediately. Refresh when within 60 seconds of expiry, using `accessTokenExpired` from task 7, and share one in-flight promise across concurrent refreshes. The access token is never persisted.

- [ ] **Step 4: Write gdrive.api.ts**

Thin wrappers, one per Drive call, no business logic. Every call takes the injected `fetchImpl`. Metadata calls use `AbortSignal.timeout(30_000)`; each upload chunk request gets its own 120 second timeout, which bounds a stalled transfer without killing a slow but live one. A 403 with `rateLimitExceeded` or `userRateLimitExceeded`, or a 429, retries up to 3 times with exponential backoff and jitter starting at 1 second before giving up as `storage.rate_limited`. Every non-retryable failure goes through `mapDriveError` from task 7, so the error vocabulary is decided in one place.

No `googleapis` dependency. Decision 8 is explicit about this and names the fallback if the implementer hits real trouble: `@googleapis/drive` is a legitimate reversal, not a failure. Raise it rather than fighting it for a day.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @docmind/server test -- gdrive
pnpm typecheck
```

```
feat(server): Google Drive token cache and REST API wrappers

Adds the module scoped access token cache, keyed by user and fingerprinted
against the refresh token so a reconnect with a different account invalidates
it, sharing one in flight promise across concurrent refreshes and never
persisting the token. Adds one thin wrapper per Drive v3 call, with the 30
second metadata timeout, the 120 second chunk timeout, the rate limit retry
with backoff, and the folder resolve or create fallback, all exercised against
the fetch fake. No driver yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 9: The Google Drive driver and the resumable upload loop

Everything below sits on top of task 7 and task 8, both of which are already tested. What is new here is the streaming loop, the driver surface and the registry entry.

**For whoever reviews this task.** Do not check the byte-range arithmetic by reading `gdrive.driver.ts` and `gdrive.fetch.test-utils.ts` side by side and confirming they agree. They will agree, and that proves nothing: the fake and the loop encode the same reading of the protocol, so a wrong reading passes. Re-derive the expected `Content-Range` sequence independently from the Google resumable upload documentation, then check it against the asserted header strings in `gdrive.models.test.ts` from task 7. Those assertions are the artefact under review, not the driver.

Read spec section 2 in full, and decisions 6, 8, 8b and 16.

**Files:**
- Create: `apps/server/src/modules/storage/drivers/gdrive/gdrive.driver.ts`, `gdrive.guide.ts`, `gdrive.driver.test.ts`
- Modify: `apps/server/src/modules/storage/storage.registry.ts`, `apps/server/src/modules/storage/storage.settings.ts`

**Interfaces:**
- Consumed: everything from tasks 7 and 8, `storage.errors.ts`, `settingsService.get` and `setInternal` as fixed in task 1.
- Produced: `createGdriveDriver({ settings, userId, fetchImpl = globalThis.fetch, chunkBytes = 8 * 1024 * 1024 })` and `gdriveDriverDefinition` carrying its `oauth` block.

**Settings**, exactly as the table in spec section 4 lists them. Three are internal: `storage.gdrive.refreshToken` (also secret), `storage.gdrive.folderId`, `storage.gdrive.connectedEmail`. The refresh token has no env seed on purpose: offering one invites pasting a token from somewhere else into a file on disk. `storage.oauth.redirectBaseUrl` is not a driver setting, so add it to the `storageSettingDefinitions` array in `storage.settings.ts` beside `activeDriverSetting` rather than to the driver. Giving it the `SERVER_BASE_URL` env name makes it track the server base URL automatically while staying overridable from the UI, which is what decision 6 needs.

- [ ] **Step 1: Write the failing tests**

`gdrive.driver.test.ts` runs the shared contract suite twice against the fake from task 7:

```ts
runDriverContractTests("gdrive", () => makeDriver({}));
runDriverContractTests("gdrive small chunks", () => makeDriver({ chunkBytes: 256 * 1024 }), { largeBodyBytes: 1024 * 1024 });
```

The second run is the whole point of decision 8b. The existing contract body is 8 MiB and the default chunk size is 8 MiB, so the default run is **one chunk** and exercises none of the resumable logic. At a 256 KiB chunk size, the protocol minimum, with a 1 MiB body, the upload takes four PUTs, which guarantees at least three 308 responses and a final chunk carrying the real total.

Plus four tests beyond the contract suite, all at the small chunk size:

```ts
  it("takes more than one PUT at a small chunk size", ...);        // assert on fake.requests
  it("resends from the committed byte after a 5xx on the second chunk", ...);
  it("sends the real total on a final partial chunk", ...);        // body not a multiple of the chunk size
  it("deletes the file id when the source stream errors mid transfer", ...);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- gdrive.driver`
Expected: cannot resolve `./gdrive.driver.js`.

- [ ] **Step 3: Write gdrive.driver.ts**

- `put`: read up to 5 MiB of the stream into memory first, because the size is unknown up front. If the stream ends inside that, do the simple upload in one request, which is what most documents will take. Otherwise open a resumable session and send what is already buffered as the first chunks. Chunks are `chunkBytes` each, every chunk except the last must be a multiple of 256 KiB, memory stays bounded at one chunk. 308 means continue, 200 or 201 means done, a 5xx means re-query the session for the committed byte range and resend from there. On a stream error, delete the file id if the session already produced one. Return the Drive file id as the key.
- Every range decision comes from the task 7 helpers, `contentRangeHeader`, `parseCommittedRange` and `chooseUploadMode`. Do not recompute an offset inline. If a case turns up that the helpers do not cover, add it to `gdrive.models.ts` with a unit test rather than inlining arithmetic that nothing tests.
- `get`: `getFileMedia`, returning the response body as a `Readable`.
- `delete`: `deleteFile`, **swallowing a 404**. Drive returns 404 for an unknown file id while the contract requires delete to be idempotent, and the upload path calls delete on both the duplicate branch and the oversize branch. This swallow lives here and not in `gdrive.api.ts`, so that `exists` still sees a real 404.
- `exists`: `getFileMetadata`, false on 404.
- `healthCheck`: read only. Refresh the token, `getAbout`, then `resolveOrCreateFolder`. No probe upload: under the drive.file scope anything the app created is writable by the app by construction, so a probe tests nothing the refresh has not, and it would leave a file in the Drive trash on every button press.

Files go into the folder named by `storage.gdrive.folderName`, flat, with `appProperties` recording `docmindKey` and `docmindDocumentId`. When `resolveOrCreateFolder` had to recreate the folder, persist the new id through `setInternal` and log a warning: failing every upload forever because the user deleted a folder by hand would be hostile.

- [ ] **Step 4: Write gdrive.guide.ts**

The eight steps from spec section 2, "What the user does in the Google Cloud console", verbatim, including the exact links and copy values. Step 5, publishing the app, is the one users skip and then wonder why they reconnect every week, so keep its explanation. Both guide notes are specified in the spec; use them as written.

- [ ] **Step 5: Register the driver**

Add `gdrive: gdriveDriverDefinition` to `storageDriverRegistry`. Until task 10 lands the OAuth routes there is no way to obtain a refresh token, so `requiredSettings` keeps the driver unselectable and `assertStorageUpdatesValid` from task 4 returns a 409 naming `connection` as missing. That is correct behaviour for this commit, not a gap: the driver is present, honest about not being connected, and cannot be activated.

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @docmind/server test
pnpm typecheck
```

Confirm from the test output that the small chunk contract run really did take more than one PUT. If the assertion on `fake.requests` passes but the count is 1, the wiring of `chunkBytes` or `largeBodyBytes` is wrong and the riskiest code in this item is still untested.

- [ ] **Step 7: Manual check 4, which this task owns**

This task is **not done** until this has been run against a real Google account and the result written into the worklog.

Upload one file over 5 MiB and one near 100 MB to a real connected Drive, then download both and compare hashes. This needs task 10 to be merged for the connect flow, so run it after task 10 and before the item is called complete, and record the result against this task.

**State plainly what the green CI tick does not prove.** The fake and the loop share a reading of the Drive resumable protocol. If that reading is wrong, the wrong assumption sits in both and the suite passes anyway. CI proves the driver is internally consistent and that the chunk arithmetic matches the asserted header strings. It does not prove Google agrees. Only this manual check does, which is why the review instruction at the top of this task asks for an independent re-derivation rather than a side by side read.

- [ ] **Step 8: Commit**

```
feat(server): Google Drive storage driver

Adds the Drive driver on top of the tested helpers and API wrappers, with an
injectable fetchImpl and an injectable chunk size, a simple upload under 5 MiB
and a chunked resumable upload above it that takes every range decision from
the pure helpers rather than computing offsets inline. The shared contract
suite runs twice, once at the default 8 MiB chunk size and once at the 256 KiB
protocol minimum with a 1 MiB body, so CI actually executes the 308 continue
path, a multi PUT Content-Range and a resend after a mid transfer 5xx. Delete
swallows a 404 in the driver, not in the API layer, because the contract
requires idempotence while exists still needs to see a real 404.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 10: The OAuth connect flow, server routes and client

**Files:**
- Create: `apps/server/src/modules/storage/storage.oauth.models.ts`, `storage.oauth.usecases.ts`, `storage.oauth.routes.ts`, and their tests
- Modify: `apps/server/src/server.ts`, `apps/server/src/modules/storage/storage.routes.ts`, `apps/client/src/pages/settings/StorageDriverCard.tsx`

**The route registration detail that will otherwise cost an afternoon.** The OAuth callback arrives as a top-level browser navigation from Google, not as an XHR. `server.ts:172` applies `app.use("/api/*", sessionMiddleware(auth))` before every feature route, so a callback registered after it would need a session cookie to survive a cross-site redirect. **The callback trusts only the signed state value and is registered alongside `registerAuthRoutes` at line 170, before the session middleware.** The state carries the user id and the driver id and is HMAC signed, so it is the stronger check anyway. The start route stays behind the session middleware, because that is where the user id comes from.

- [ ] **Step 1: Write the failing tests**

`storage.oauth.models.test.ts`:

```ts
  it("round trips a signed state", ...);
  it("rejects a tampered payload", ...);
  it("rejects an expired state", ...);          // ten minute expiry
  it("rejects a state signed for one driver on another driver callback", ...);
  it("builds the authorize URL with access_type offline and the drive.file scope", ...);
```

The signing key is derived from `SETTINGS_ENCRYPTION_KEY` with HKDF and the label `oauth-state`, as `DOCMIND-DESIGN.md` specifies. Derive it in the models file with `node:crypto`; do not reuse the settings encryption key directly.

Route tests, against a stubbed token endpoint:

```ts
  it("redirects to Google with a signed state", ...);
  it("exchanges the code, stores the refresh token and redirects to settings", ...);
  it("rejects a replayed state", ...);
  it("rejects an expired state", ...);
  it("rejects a callback with an error parameter from Google", ...);
  it("disconnect clears the refresh token, folder id and connected email", ...);
```

And one that is the reason task 1 exists:

```ts
  it("stores the refresh token as ciphertext", async () => {
    // after a successful callback, debugRows must show enc:v1: for
    // storage.gdrive.refreshToken, and GET /api/settings must not contain the key at all
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server test -- oauth`

- [ ] **Step 3: Implement the models, then the usecases, then the routes**

`onConnected` on the driver definition does the Drive specific part: call `about.get` for the account email, find or create the DocMind folder, and save `folderId` and `connectedEmail` through `setInternal`. The two routes stay driver agnostic and read everything they need from `definition.oauth`.

Disconnect clears `refreshToken`, `folderId` and `connectedEmail` by passing `null` to `setInternal`, which is the clear path added in task 1. It refuses when the driver is active, with `storage.driver_in_use`, the same rule as clearing a credential.

- [ ] **Step 4: Wire server.ts**

Register the callback before the session middleware, immediately after `registerAuthRoutes({ app, auth, db })` at line 170. Register the start route with the other feature routes after line 172. Add a comment at the callback registration saying why it sits there, because the next person to tidy the route list will otherwise move it.

- [ ] **Step 5: The client connect flow**

Connect, Reconnect and Disconnect on the Drive card, chosen by `connection.connected` and `lastAuthError`. A copy button for the exact redirect URI. A note under the Connect button, which is the honest statement decision 6 requires: **connect Google Drive from a browser that can reach the redirect base URL.** For most users that means the machine running DocMind, or a deployment with a stable public URL. A quick tunnel URL changes every run, so registering it with Google is not practical. Connect once locally and the refresh token then works from anywhere.

- [ ] **Step 6: Run both suites and commit**

```
feat(server): Google Drive OAuth connect, callback and disconnect

Adds the driver agnostic OAuth start and callback routes, HMAC signed state
derived from SETTINGS_ENCRYPTION_KEY with HKDF and a ten minute expiry, and the
disconnect action. The callback is registered before the session middleware and
trusts only the signed state, because it arrives as a top level navigation from
Google and would otherwise need a cookie to survive a cross site redirect. The
refresh token is stored encrypted through setInternal and never appears in
GET /api/settings.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

### Task 11: Documentation

The credential clearing amendment to `DOCMIND-DESIGN.md` is **not** here. It is step 7 of task 4, where the behaviour actually changes. Start this task by confirming that edit is already in the tree:

```bash
grep -n "refuses to clear credentials" DOCMIND-DESIGN.md
```

It must print nothing. If it prints a line, task 4 step 7 was skipped and it belongs there, not here.

**Files:**
- Modify: `apps/server/.env.example`
- Modify: `DOCMIND-DESIGN.md`
- Modify: `docs/FEATURES.md`

- [ ] **Step 1: .env.example**

Add the seeds, matching the setting env names exactly: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_FOLDER_NAME`. There is deliberately **no** seed for the refresh token. Add a one line comment saying so, otherwise someone will add one later thinking it was an oversight.

- [ ] **Step 2: DOCMIND-DESIGN.md, the redirect base URL setting**

The settings example block at lines 205 to 214 lists storage keys. Add `storage.oauth.redirectBaseUrl url env SERVER_BASE_URL` to it. In the OAuth flow paragraph at lines 326 to 333, the sentence "The form shows the exact redirect URI derived from the server base URL" becomes the setting: the redirect base URL is its own setting defaulting to `SERVER_BASE_URL`, because the tunnel workflow otherwise puts the browser on a host that cannot reach the callback.

- [ ] **Step 3: docs/FEATURES.md**

Item 9 at line 29 covers settings including "Storage drivers with guides and OAuth connect". Mark its progress. Leave item 30, moving documents between drivers, exactly where it is: this item deliberately does not move anything.

- [ ] **Step 4: Commit**

```
docs: S3 and Google Drive storage driver documentation

Adds the S3 and Drive env seeds to .env.example, with a note that the refresh
token deliberately has none, records storage.oauth.redirectBaseUrl in the
design doc settings list and explains why it is separate from SERVER_BASE_URL,
and updates feature item 9.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HpHSkxKKsL95NvKSzoKZgT
```

---

## Before calling this done

Automated, all of it a normal run from the repository root:

- [ ] `pnpm typecheck` and `pnpm test` pass.
- [ ] The contract suite passes for local, for S3 against a local MinIO with `S3_TEST_ENDPOINT` set, and for Google Drive against the fetch fake at **both** chunk sizes, with the small chunk run observably taking more than one PUT.
- [ ] `git diff --stat main` shows no change to any `*.tables.ts` file and no new file under `apps/server/drizzle/`. This item needs no migration and must not have produced one.
- [ ] The `setInternal` regression test was watched failing against the unfixed code, and the fix was proposed to the `bug-fix-record` agent and approved before being recorded.

Behaviour, checked by hand against a running server:

- [ ] `GET /api/settings` contains no `storage.gdrive.refreshToken`, no `folderId` and no `connectedEmail`, and returns `storage.s3.secretAccessKey` only as `{ isSet, lastFour }`.
- [ ] `select value from settings where key = 'storage.gdrive.refreshToken'` returns a string starting with `enc:v1:`.
- [ ] Switching the active driver to a half configured driver returns 409 and names the missing keys. Switching with the credentials in the same PUT succeeds.
- [ ] A document uploaded under the local driver still downloads after the active driver has been switched to S3.
- [ ] A document on a disconnected driver still appears in the library and in search, shows the reconnect message on download, can still be moved to trash through `remove()`, and can still be permanently deleted through `purge()` with a warning logged and the blob left orphaned.
- [ ] Clearing the credentials of an inactive driver that holds documents shows the confirm copy from spec section 4 with the right singular or plural, and succeeds. Clearing the active driver credentials returns 409.

The seven manual checks in spec section 8, "What must be manual", run and recorded in the worklog. None of them can be honestly automated here:

- [ ] 1. The real Google consent screen, first connect, and the redirect URI matching.
- [ ] 2. Access token refresh after the first hour: upload, wait, download.
- [ ] 3. Revoke DocMind from the Google third-party access page, confirm the Reconnect state appears, reconnect, confirm service resumes.
- [ ] 4. **Owned by task 9.** A real upload over 5 MiB and one near 100 MB to Drive. This is the only check that can catch a protocol assumption baked into both the driver and the fake.
- [ ] 5. One real bucket on each of Cloudflare R2, Backblaze B2 and AWS S3: create, test connection, upload, download, delete. This is where decision 10 on checksums and decision 11 on addressing are actually validated.
- [ ] 6. Switch the active driver with documents already in the library, then download an older document from the previous driver.
- [ ] 7. Clear the credentials of a non-active driver that still holds documents, confirm the library, search and chat still work, and that download shows the right message.

Process, per `CLAUDE.md`:

- [ ] The `code-reviewer` agent ran before every commit, with regression impact analysis on every changed export, route and setting. In particular: `setInternal`, `purge`, `createDocumentsService`, `createExportService`, `createStorageService`, `runDriverContractTests`, `StorageDriverDefinition`, and every new `storage.*` setting key.
- [ ] Nothing was merged into `main`, pushed, or deployed without asking the user first.
