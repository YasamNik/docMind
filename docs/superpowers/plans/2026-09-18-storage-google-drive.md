# Storage: Google Drive and the OAuth plumbing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store documents in the user's own Google Drive, connected through a consent flow
that any future OAuth driver (OneDrive next) reuses without new routes.

**Architecture:** `StorageDriverDefinition` gains an optional `oauth` hook. Two routes in
the existing `storage.routes.ts`, parameterized by driver id, drive every OAuth driver:
connect issues a signed state and redirects to the provider, callback verifies the state,
exchanges the code and stores the refresh token as a secret. The Drive driver itself is an
ordinary driver on top of that, talking to Drive v3 over REST with an access token the
auth client refreshes.

**Tech Stack:** Hono, valibot, vitest, `google-auth-library`, Drive v3 REST over `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-18-storage-drivers-design.md` sections 3 and 4.

**Depends on:** `docs/superpowers/plans/2026-09-18-storage-s3-and-scope.md`, all seven
tasks landed. This plan assumes `storage.routes.ts`, `listDriverSummaries`, the
`describeLocation` contract method and the rebuilt Storage tab already exist.

## Global Constraints

- No em dashes anywhere: code, comments, tests, docs, UI copy, commit messages.
- Module file roles: pure logic in `*.models.ts`, orchestration in `*.usecases.ts`, Hono
  only in `*.routes.ts`. Every HTTP input parsed with valibot before use.
- `clientSecret` and `refreshToken` are `secret: true`. They never appear in a log, an
  error, a redirect URL or an API response. An access token is never persisted at all.
- Scope is `drive.file` only. Anything wider would need Google app verification, and the
  app has no business reading files it did not create.
- No `*.tables.ts` change and no migration. Tokens live in settings, which is a key value
  store. If a task seems to need a migration, stop and raise it.
- To run one file's tests: `pnpm --filter @docmind/server exec vitest run <pattern>`.
  `pnpm --filter @docmind/server test -- <pattern>` does not filter.
- Node 22: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22`.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/modules/storage/storage.models.ts` | new: sign, verify and expire the OAuth state. Pure, unit tested |
| `apps/server/src/modules/storage/storage.types.ts` | the `oauth` hook on the definition |
| `apps/server/src/modules/storage/storage.routes.ts` | connect and callback, parameterized by driver |
| `apps/server/src/modules/storage/drivers/google-drive/google-drive.driver.ts` | the driver, settings and guide |
| `apps/server/src/modules/storage/drivers/google-drive/google-drive.client.ts` | Drive v3 REST calls and the resumable upload |
| `apps/client/src/pages/settings/StorageTab.tsx` | Connect and Disconnect for OAuth drivers |

---

### Task 1: A signed OAuth state that cannot be replayed or forged

**Files:**
- Create: `apps/server/src/modules/storage/storage.models.ts`
- Create: `apps/server/src/modules/storage/storage.models.test.ts`

**Interfaces:**
- Produces: `signOAuthState({ userId, driverId, secretHex, now? }): string` and
  `verifyOAuthState({ state, secretHex, now? }): { userId: string; driverId: string }`,
  which throws an `AppError` with code `storage.invalid_state` on a bad signature, a bad
  shape or an expired state. Task 2 uses both.

**Why this exists.** The callback arrives as a browser redirect from Google, not as an app
fetch, so it cannot rely on a session cookie to know whose settings to write. The state
carries that identity, which means the state has to be unforgeable: without a signature,
anyone who could make the user's browser hit the callback could bind their own Google
account to the user's storage.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { signOAuthState, verifyOAuthState } from "./storage.models.js";

const secretHex = "11".repeat(32);

describe("oauth state", () => {
  it("round trips the user and driver it was issued for", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    expect(verifyOAuthState({ state, secretHex })).toEqual({ userId: "user_1", driverId: "googleDrive" });
  });

  it("rejects a state whose payload was edited", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    const [payload, signature] = state.split(".");
    const tampered = `${Buffer.from(Buffer.from(payload!, "base64url").toString().replace("user_1", "user_2")).toString("base64url")}.${signature}`;
    expect(() => verifyOAuthState({ state: tampered, secretHex })).toThrow(/invalid/i);
  });

  it("rejects a state signed with a different key", () => {
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex });
    expect(() => verifyOAuthState({ state, secretHex: "22".repeat(32) })).toThrow(/invalid/i);
  });

  it("rejects a state older than ten minutes", () => {
    const issued = new Date("2026-09-18T12:00:00.000Z");
    const state = signOAuthState({ userId: "user_1", driverId: "googleDrive", secretHex, now: issued });
    const late = new Date("2026-09-18T12:10:01.000Z");
    expect(() => verifyOAuthState({ state, secretHex, now: late })).toThrow(/expired/i);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run storage.models`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement it**

Derive the signing key with `hkdfSync` from `node:crypto` off `SETTINGS_ENCRYPTION_KEY`
with the label `oauth-state`, so the settings key is never used directly for two purposes.
Payload is `{ userId, driverId, issuedAt }` as base64url JSON, signature is an HMAC over
the payload, compared with `timingSafeEqual`. Expiry is ten minutes.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm --filter @docmind/server exec vitest run storage.models`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/storage
git commit -m "feat(server): signed, expiring state for the storage oauth flow"
```

---

### Task 2: Generic connect and callback routes

**Files:**
- Modify: `apps/server/src/modules/storage/storage.types.ts`
- Modify: `apps/server/src/modules/storage/storage.routes.ts`
- Modify: `apps/server/src/modules/storage/storage.usecases.ts`
- Test: `apps/server/src/modules/storage/storage.routes.test.ts`

**Interfaces:**
- Consumes: Task 1's state helpers, `storageDriverRegistry`, `settingsService`.
- Produces: the `oauth` hook, which Task 3's driver fills in:

```ts
export type StorageOAuth = {
  // Where to send the browser. The state is opaque to the driver.
  authorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string;
  // Swap the code for a refresh token and whatever identifies the account.
  exchange(args: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<{ refreshToken: string; accountEmail: string }>;
  // Which settings hold the credentials, so the routes stay driver agnostic.
  keys: { clientId: string; clientSecret: string; refreshToken: string; accountEmail: string };
};
```

and `GET /api/storage/drivers/:id/connect`, `GET /api/storage/drivers/:id/callback`.

- [ ] **Step 1: Write the failing tests**

```ts
  it("sends the browser to the provider with a signed state", async () => {
    await t.services.settingsService.set(userId, { "storage.googleDrive.clientId": "cid", "storage.googleDrive.clientSecret": "csecret" });

    const res = await t.app.request("/api/storage/drivers/googleDrive/connect", { headers: { cookie }, redirect: "manual" });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("state")).toMatch(/\./);
    // The secret never leaves the server.
    expect(res.headers.get("location")).not.toContain("csecret");
  });

  it("refuses to connect a driver that has no oauth hook", async () => {
    expect((await t.app.request("/api/storage/drivers/local/connect", { headers: { cookie } })).status).toBe(400);
  });

  it("rejects a callback whose state was not issued by us", async () => {
    const res = await t.app.request("/api/storage/drivers/googleDrive/callback?code=abc&state=forged.signature", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("stores the refresh token and the account on a good callback", async () => {
    // exchange is stubbed through the test app's driver registry override.
    const state = signOAuthState({ userId, driverId: "googleDrive", secretHex: t.config.settingsEncryptionKey });
    const res = await t.app.request(`/api/storage/drivers/googleDrive/callback?code=abc&state=${state}`, { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(await t.services.settingsService.get(userId, "storage.googleDrive.accountEmail")).toBe("someone@example.com");
    const stored = await t.db.all(sql`select value, is_secret from settings where key = 'storage.googleDrive.refreshToken'`);
    expect(stored[0]!.is_secret).toBe(1);
  });
```

Note the last test sends no cookie on purpose: the callback must work from a redirect that
carries no session, which is exactly why the state is signed.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/server exec vitest run storage.routes`
Expected: FAIL, 404 on the two new routes.

- [ ] **Step 3: Add the hook to the contract**

Add `oauth?: StorageOAuth` to `StorageDriverDefinition` and export `StorageOAuth` from
`storage.types.ts`.

- [ ] **Step 4: Add the routes**

Both parse `:id` with `v.picklist(storageDriverIds)`. Connect reads the driver's
`clientId` setting, builds the redirect URI from the request origin
(`new URL(c.req.url).origin` plus `/api/storage/drivers/<id>/callback`), signs the state
and 302s. A driver with no `oauth` hook is a 400. Callback verifies the state, loads the
client id and secret for the `userId` the state names, calls `exchange`, writes the
refresh token through `settingsService.set` so it is encrypted, writes the account email,
and 302s to `/settings?tab=storage&connected=<id>`.

- [ ] **Step 5: Surface the redirect URI for the setup guide**

Add `redirectUri` to each driver summary in `listDriverSummaries`, built from the same
request origin, so the settings page can show the exact value to paste into Google Cloud.
The guide is useless without it: a mismatched redirect URI is the most common way this
setup fails.

- [ ] **Step 6: Run and commit**

Run: `pnpm --filter @docmind/server exec vitest run storage` then `pnpm typecheck`

```bash
git add apps/server/src/modules/storage
git commit -m "feat(server): generic oauth connect and callback for storage drivers"
```

---

### Task 3: The Google Drive driver

**Files:**
- Create: `apps/server/src/modules/storage/drivers/google-drive/google-drive.client.ts`
- Create: `apps/server/src/modules/storage/drivers/google-drive/google-drive.driver.ts`
- Create: `apps/server/src/modules/storage/drivers/google-drive/google-drive.driver.test.ts`
- Modify: `apps/server/src/modules/storage/storage.registry.ts`
- Modify: `apps/server/package.json` (add `google-auth-library`)

**Interfaces:**
- Consumes: `StorageDriver`, `StorageOAuth`, the shared contract suite.
- Produces: registry entry `googleDrive`, settings under `storage.googleDrive.`.

**Dependency choice.** `google-auth-library` only, not `googleapis`. Four endpoints are
needed (files create, files get, files delete, about get) and the umbrella package pulls
in every Google API client for them. The auth library gives the token refresh, which is
the part worth not writing by hand.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @docmind/server add google-auth-library
```

- [ ] **Step 2: Write the failing contract test**

Run the shared suite against a driver built on a fake `fetch` that implements the Drive
subset: a `Map` of file id to `{ name, body }`, the resumable session endpoints, and the
`alt=media` download. The fake throws on any URL it does not recognize, naming it, so an
unhandled call fails loudly rather than silently.

```ts
it("uploads a body over five megabytes through a resumable session", async () => {
  const { driver, sessions } = makeDriverWithFakeDrive();
  await driver.put({ key: "big.bin", body: Readable.from([Buffer.alloc(6 * 1024 * 1024, "x")]) });
  expect(sessions.completed).toBe(1);
});

it("keeps small uploads on the single request path", async () => {
  const { driver, sessions } = makeDriverWithFakeDrive();
  await driver.put({ key: "small.txt", body: Readable.from(["hello"]) });
  expect(sessions.completed).toBe(0);
});

it("describes a file as a Drive link without a network call", () => {
  const { driver } = makeDriverWithFakeDrive();
  expect(driver.describeLocation({ key: "1a2b3c" }).url).toBe("https://drive.google.com/file/d/1a2b3c/view");
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @docmind/server exec vitest run google-drive`
Expected: FAIL, the module does not exist.

- [ ] **Step 4: Write the Drive client**

`google-drive.client.ts` holds the REST calls and nothing else: `createFolder`,
`findFolder`, `uploadSimple`, `uploadResumable`, `download`, `remove`, `about`. The
resumable path starts a session, then streams the body in eight megabyte chunks with the
`Content-Range` header each chunk needs, so memory stays flat whatever the file size. The
threshold is five megabytes, per the design doc.

- [ ] **Step 5: Write the driver**

`storage_key` is the Drive file id, bare, since `storage_driver` already says which driver
owns the key. `put` returns the new id as the key, which is how the id reaches the
document row. `get` streams `alt=media`. `exists` is a files get for the id, 404 meaning
false. `delete` is files delete. `healthCheck` calls about get, then creates and trashes a
probe file so write access is proven, not assumed. `describeLocation` returns the folder
name and filename as the label and the Drive link as the url, built from the id alone.

- [ ] **Step 6: Settings, guide and the oauth hook**

Settings under `storage.googleDrive.`: `clientId`, `clientSecret` (secret),
`refreshToken` (secret, written only by the callback), `accountEmail`, `folderId` (blank
means create a DocMind folder on first use).

The guide walks the whole Google Cloud setup, since this is where the user will actually
get stuck: create a project, enable the Drive API, configure the consent screen and
**publish it** (an app left in testing mode expires refresh tokens after seven days),
create a Web application OAuth client, paste the redirect URI shown on the page, copy the
client id and secret back here, then press Connect. A note says to connect from the
machine running DocMind when possible, because a Cloudflare quick tunnel hostname changes
on restart and the redirect URI has to be registered in advance.

The `oauth` hook fills in `authorizeUrl` (scope `https://www.googleapis.com/auth/drive.file`,
`access_type=offline`, `prompt=consent`), `exchange` (code for refresh token, then about
get for the account email), and the four setting keys.

- [ ] **Step 7: Register and run**

```ts
export const storageDriverRegistry = {
  local: localDriverDefinition,
  s3: s3DriverDefinition,
  googleDrive: googleDriveDriverDefinition,
} as const satisfies Record<string, StorageDriverDefinition>;
```

Run: `pnpm --filter @docmind/server test` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(server): google drive storage driver"
```

---

### Task 4: Connect and Disconnect in the Storage tab

**Files:**
- Modify: `apps/client/src/pages/settings/StorageTab.tsx`
- Modify: `apps/client/src/lib/storage-api.ts`
- Test: `apps/client/src/pages/settings/StorageTab.test.tsx`

**Interfaces:**
- Consumes: `redirectUri` and `accountEmail` on the driver summary from Task 2.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the exact redirect URI to register, with a copy button", async () => { /* ... */ });

it("offers Connect for an oauth driver that has a client id but no token", async () => { /* ... */ });

it("shows the connected account and offers Disconnect once a token exists", async () => { /* ... */ });

it("does not offer Connect before the client id and secret are saved", async () => { /* ... */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @docmind/client exec vitest run StorageTab`

- [ ] **Step 3: Implement**

For a driver whose summary carries an `oauth` flag: show the redirect URI with a copy
button above the fields, a Connect button that navigates to
`/api/storage/drivers/<id>/connect` (a full navigation, not a fetch, because it ends at
Google), the connected account email once present, and a Disconnect that clears the
refresh token after a confirmation. Connect stays disabled until the client id and secret
are saved, since the flow cannot start without them.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @docmind/client exec vitest run StorageTab` then `pnpm typecheck`

```bash
git add apps/client/src
git commit -m "feat(client): connect and disconnect google drive from the storage tab"
```

---

## Self-review

**Spec coverage.** Spec section 3 is Task 3, section 4 is Tasks 1, 2 and 4. The spec's
"connecting is one time, prefer localhost" note is in Task 3's guide. The design doc's
HKDF state mechanism is Task 1, its parameterized routes are Task 2, its `drive.file`
scope and five megabyte resumable threshold are Task 3.

**Decisions made here rather than left open.** The dependency is `google-auth-library`
alone. The Drive file id is the storage key, bare. The callback carries identity in the
signed state because it has no session. The redirect URI is derived from the request
origin, and the driver summary exposes it so the guide can show the exact string.

**Type consistency.** `StorageOAuth`, its `keys` object, `redirectUri` and `accountEmail`
are spelled the same in Tasks 2, 3 and 4.

**No migration.** Tokens and ids live in settings, a key value store. No table changes.
