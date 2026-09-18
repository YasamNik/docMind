# Storage drivers: S3 compatible and Google Drive (feature item #9, phase 3): design

Status: draft, 2026-09-18. Written to follow the document types item currently in flight.
Needs a `plan-reviewer` pass before an implementation plan. One decision, clearing the
credentials of a driver that still holds documents, was ruled on by the user on
2026-09-18: see "Rulings" at the end.

## Goal

Add two storage drivers beside the existing local driver, both configurable from the
Settings page: an S3 compatible driver (AWS S3, MinIO, Cloudflare R2, Backblaze B2,
Wasabi, DigitalOcean Spaces) and a Google Drive driver with an OAuth connect flow. The
active driver receives new uploads. Every existing document keeps reading from the driver
recorded on its row.

## Not in scope

Stated plainly, with the reason.

- **OneDrive.** It shares the whole OAuth machinery this spec builds, so it is cheap
  afterwards, but Microsoft Graph upload sessions, the app folder model, and the Azure
  app registration guide are a separate body of work and a separate set of manual tests.
  Do it after Google Drive has run in production for a while.
- **Moving documents between drivers.** That is feature item #30, already listed in
  `docs/FEATURES.md` as the follow-up to the storage design. This item deliberately
  leaves old documents where they are, see section 5.
- **Importing or scanning files that already live on the drive.** `DOCMIND-DESIGN.md`
  rules this out: "Storage is a blob backend only. DocMind is the source of truth; it
  never scans or imports files that already live on a drive."
- **Google Shared Drives and Team Drives.** A single user with a personal account is the
  target. Supporting a shared drive means a driveId and supportsAllDrives on every call
  for no benefit here.
- **Mirroring the library as a folder tree on the drive** so it opens as an Obsidian
  vault. That is part of item #34 and needs a rename and move story this item lacks.
- **Presigned direct-to-browser upload and download.** Every byte keeps flowing through
  the server. Presigned URLs would change the download route, the auth story, and the
  assumptions of the extraction pipeline all at once.
- **Server-side encryption configuration, KMS keys, storage classes, versioning, object
  lock.** The guide mentions a lifecycle rule for aborting incomplete multipart uploads
  and nothing else.
- **Per-document driver override.** The active driver decides, per upload.
- **Key rotation for SETTINGS_ENCRYPTION_KEY.** Already out of scope project-wide.
- **Proton Drive.** Deferred in `DOCMIND-DESIGN.md` for SDK reasons that have not changed.

---

## 1. The driver interface

### What exists today

`apps/server/src/modules/storage/storage.types.ts`, quoted in full:

```ts
export type StorageDriver = {
  id: string;
  put(args: { key: string; body: Readable; mimeType?: string; sizeBytes?: number }): Promise<{ key: string }>;
  get(args: { key: string }): Promise<Readable>;
  delete(args: { key: string }): Promise<void>;
  exists(args: { key: string }): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
};

export type SetupGuideStep = { text: string; link?: string; copyValue?: string };
export type SetupGuide = { title: string; intro: string; steps: SetupGuideStep[]; notes: string[] };

export type StorageDriverDefinition = {
  id: string;
  label: string;
  settings: SettingDefinition[];
  guide: SetupGuide;
  create(args: { settings: SettingsService; userId: string }): Promise<StorageDriver>;
};
```

### Decision 1: StorageDriver does not change. Not one line.

The interface already survives an opaque remote id, and that is not luck. `put` returns
`{ key }` rather than void, and the caller stores the returned value, not the one it
passed in. `apps/server/src/modules/documents/documents.usecases.ts`, lines 60 to 88:

```ts
const key = buildStorageKey({ userId, documentId, filename: safeName, uploadedAt });
...
driver.put({ key, body: toStorage, mimeType }),
...
storageDriver: driverId,
storageKey: stored.key,
```

So the Google Drive driver may treat the incoming key as a naming hint, create the file,
and return the Drive file id as the key. Every later `get`, `delete`, and `exists` gets
that id back. `documents.usecases.ts` lines 166 and 173, and `export.usecases.ts` line
42, all read `document.storageKey` and never rebuild a path.

Streaming needs no change either. `put` takes a `Readable`, `get` returns one. The upload
path tees the request body through a hashing `PassThrough` into `driver.put`, so the
driver receives a stream whose total length is unknown when the call starts. Both new
drivers handle that (S3 through multipart, Drive through chunked resumable), so
`sizeBytes` stays optional and stays unused by them.

**Rejected alternative:** adding `getSignedUrl`, `getRange`, or `copy` now. None has a
caller in this item. `getRange` would be needed for byte-range media playback, `copy` for
the move-documents job (#30). Add each with the feature that needs it.

### Decision 2: StorageDriverDefinition grows three additive fields

```ts
export type StorageDriverDefinition = {
  id: string;
  label: string;
  settings: SettingDefinition[];
  // Keys from `settings` that must resolve to a non-empty value before this driver
  // can be made active. Checked by the settings beforeSet guard and reported by
  // GET /api/storage/drivers so the UI can disable the option and name what is missing.
  requiredSettings: string[];
  // Present only on drivers that connect through OAuth. Drives the Connect button
  // and the two OAuth routes, which stay driver agnostic.
  oauth?: StorageOauthDefinition;
  guide: SetupGuide;
  create(args: { settings: SettingsService; userId: string }): Promise<StorageDriver>;
};

export type StorageOauthDefinition = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  authorizeParams: Record<string, string>;  // for example access_type=offline
  refreshTokenKey: string;                  // internal secret setting key
  accountLabelKey: string;                  // internal setting key
  onConnected(args: {
    settings: SettingsService;
    userId: string;
    accessToken: string;
  }): Promise<{ accountLabel: string }>;
};
```

Effect on the existing local driver: one added line, `requiredSettings: []`, in
`drivers/local/local.driver.ts`. Nothing else in `local.driver.ts`,
`storage.registry.ts`, or `storage.usecases.ts` changes shape, and `storage.settings.ts`
keeps composing driver settings through its existing flatMap untouched.

### Decision 3: three contract clarifications, written into the shared test suite

The interface stays, but three behaviours are currently only implied by the local driver
and must become explicit, or the two new drivers will diverge silently.

1. **The returned key is authoritative and may differ from the requested key.** The
   requested key is a naming hint. Local returns it, S3 returns it prefixed, Google Drive
   returns a file id. Callers must never reconstruct a key.
2. **Delete is idempotent.** Deleting a key that does not exist resolves, it does not
   throw. Local already does this (`rm(full, { force: true })`) and S3 DeleteObject does
   too, but Drive returns 404 on an unknown file id and the driver must swallow it. The
   upload path calls `driver.delete` on both the duplicate branch and the oversize
   branch, and a throw there would turn a duplicate upload into a 500.
3. **Keys are opaque strings, not paths.** The shared contract suite must stop using key
   shapes that only make sense on a filesystem. Path traversal safety stays a
   local-driver-only concern, where it already lives in `local.driver.test.ts`.

### Decision 4: a shared error mapping module

New file `apps/server/src/modules/storage/storage.errors.ts`, exporting helpers that
build `AppError`s with a fixed code set. `DOCMIND-DESIGN.md` names the set loosely ("auth
expired, not found, quota, network"); this pins it down.

| Code | Status | Meaning |
|------|--------|---------|
| `storage.not_found` | 404 | Key does not exist. Already used by the local driver. |
| `storage.invalid_key` | 400 | Local driver only, traversal or absolute key. Exists. |
| `storage.unknown_driver` | 400 | Exists in `storage.usecases.ts`. |
| `storage.not_configured` | 409 | Required settings missing, or Drive not connected. New. |
| `storage.auth_expired` | 401 | Refresh token revoked, keys rejected. New. |
| `storage.quota` | 507 | Drive full, bucket quota exceeded. New. |
| `storage.rate_limited` | 429 | Google rate limit, S3 SlowDown. New. |
| `storage.network` | 502 | Timeout, DNS, connection reset. New. |
| `storage.remote_error` | 502 | Anything else. New. |
| `storage.driver_in_use` | 409 | Clearing the active driver credentials. New. |

Every driver maps its provider errors into these. The message always ends with the
provider error text, unedited, because that is what makes a misconfiguration
diagnosable. Secrets never appear in these messages.

---

## 2. Google Drive: which auth flow

### Decision 5: user OAuth with a stored refresh token. Not a service account.

**Chosen:** a Web application OAuth client, `access_type=offline`, scope
`https://www.googleapis.com/auth/drive.file` only, refresh token stored as an encrypted
secret setting.

**Rejected: a service account plus a folder shared with it.** It is genuinely more
attractive on paper for a self-hosted single-user server: a JSON key file, no consent
screen, no redirect URI, no token expiry, no seven-day rule. It fails on one hard fact.
A service account has no Drive storage quota of its own. When a service account creates
a file inside a folder that a consumer Gmail account shared with it, the file is owned by
the service account and counts against the service account quota, which is zero, so
uploads fail with `storageQuotaExceeded`. The arrangement works only with a Google
Workspace Shared Drive, which a self-hosted personal user usually does not have, or with
domain-wide delegation, which needs a Workspace admin. There is a second problem even
where it works: files owned by a service account are awkward for the user to reach, and
deleting the key orphans them. The point of putting documents in the user Drive is that
the user owns them.

**Also rejected: an installed/desktop client with the out-of-band flow.** Google shut
`urn:ietf:wg:oauth:2.0:oob` down. A loopback redirect would work but has the same
redirect-URI reachability problem as a web client with less clarity.

### Scope choice

`drive.file` only, which grants access exclusively to files the app itself creates. It is
a non-sensitive scope, so **no Google app verification and no security assessment is
required** and the consent screen shows no scary warning. The cost: DocMind can never see
or touch anything else in the Drive, which is exactly the behaviour the design doc wants
from a blob backend that never scans or imports.

**Rejected: `drive` or `drive.readonly`.** Both are restricted scopes requiring
verification and, past a threshold, a third-party security assessment costing thousands
of dollars a year. Disqualifying for a self-hosted app.

### What the user does in the Google Cloud console

This becomes the SetupGuide on the driver definition, rendered beside the form.

1. Create a Google Cloud project or pick an existing one.
   Link: `https://console.cloud.google.com/projectcreate`
2. Enable the Google Drive API for that project.
   Link: `https://console.cloud.google.com/apis/library/drive.googleapis.com`
3. Configure the OAuth consent screen. User type External. App name, your own email as
   the support email and as the developer contact. A non-sensitive scope needs no privacy
   policy and no homepage.
   Link: `https://console.cloud.google.com/apis/credentials/consent`
4. Add the scope `https://www.googleapis.com/auth/drive.file`. Google lists it as
   non-sensitive, so no verification is required.
   Copy value: `https://www.googleapis.com/auth/drive.file`
5. **Publish the app.** Set the publishing status to "In production". While the app sits
   in Testing, Google expires every refresh token after seven days and DocMind will ask
   you to reconnect every week. An External app using only non-sensitive scopes can be
   published without going through verification.
6. Credentials, Create credentials, OAuth client ID, application type Web application.
   Link: `https://console.cloud.google.com/apis/credentials`
7. Under Authorized redirect URIs, paste this exact URI. Scheme, host, port and path must
   match character for character.
   Copy value: the value of `storage.oauth.redirectBaseUrl` plus
   `/api/storage/oauth/gdrive/callback`, for example
   `http://localhost:4000/api/storage/oauth/gdrive/callback`
8. Paste the client ID and client secret into the fields on the left, save, then click
   Connect Google Drive and approve the consent screen.

Guide notes: "DocMind only ever sees files it created. The drive.file scope gives it no
access to the rest of your Drive." and "If this card later shows Reconnect, your refresh
token was revoked, usually by a password change or by removing DocMind from your Google
account third-party access list."

### Decision 6: the redirect base URL is its own setting

`storage.oauth.redirectBaseUrl`, default `SERVER_BASE_URL`. Google requires an exact,
pre-registered redirect URI, and the tunnel workflow this project uses (see
`.claude/rules/tunnel.md`) puts the browser on a `*.trycloudflare.com` host while
`SERVER_BASE_URL` is `http://localhost:4000`. Without this setting the callback would
send a remote browser to a localhost it cannot reach.

The honest statement, which belongs in the UI as a note under the Connect button:
**connect Google Drive from a browser that can reach the redirect base URL.** For most
users that means connecting from the machine running DocMind, or from a deployment with
a stable public URL. A quick tunnel URL changes every run, so registering it with Google
is not practical. Connect once locally and the refresh token then works from anywhere.

### Token storage and refresh

| What | Where | Secret | Internal |
|------|-------|--------|----------|
| Client ID | `storage.gdrive.clientId` | no | no |
| Client secret | `storage.gdrive.clientSecret` | yes | no |
| Refresh token | `storage.gdrive.refreshToken` | yes | yes |
| Connected account email | `storage.gdrive.connectedEmail` | no | yes |
| DocMind folder id | `storage.gdrive.folderId` | no | yes |
| Access token | in-process memory only | n/a | n/a |

The access token is never persisted. It lives in a module-scoped cache in
`drivers/gdrive/gdrive.tokens.ts`, keyed by user id, holding
`{ accessToken, expiresAt, refreshTokenFingerprint }`. This matters because
`storageService.getDriver` calls `definition.create` on **every** request, so a cache
held on the driver instance would mean a token exchange per download. The fingerprint is
a short hash of the refresh token, so reconnecting with a different account invalidates
the cache immediately. Refresh happens when the token is within 60 seconds of expiry, and
concurrent refreshes share one in-flight promise.

**Rejected: persisting the access token as an internal secret setting.** It means a
database write roughly once an hour forever, and storing an hour-lived credential buys
nothing when the refresh token that mints it already sits beside it.

### Decision 7: setInternal must learn to encrypt

This is a real blocker found while reading the code, not a hypothetical, and it is a
defect in shipped code in its own right. The full write-up, severity, and regression
test are in the section "Bug found in shipped code" below. The refresh
token must be both `secret: true` (encrypted at rest, never returned by the API) and
`internal: true` (written only by the OAuth callback, never through `PUT /api/settings`).
Today those flags cannot be combined. `settings.usecases.ts`:

```ts
async setInternal(userId: string, key: string, value: unknown) {
  const definition = registry.get(key);
  if (!definition.internal) {
    throw new Error(`setInternal called on non-internal setting "${key}"`);
  }
  const parsed = parseOrThrow(definition, value);
  await repository.upsert({ userId, key, isSecret: false, value: JSON.stringify(parsed) });
  cache.delete(userId);
}
```

It hard-codes `isSecret: false` and JSON-stringifies. A secret written this way is stored
in plaintext, and `resolveRaw` then tries to `decryptSecret` it on read, because it
branches on `definition.secret` and not on the stored `is_secret` column, and throws
`settings.bad_ciphertext`. Broken in both directions.

Fix: `setInternal` mirrors the secret branch of `set()`, encrypting with `encryptSecret`
and writing `isSecret: true` when `definition.secret` is true. It also gains a clear path
(a `null` value removes the row), which Disconnect needs. Small, additive, and it gets a
unit test asserting the stored row is ciphertext and that the round trip returns
plaintext.

Also worth stating: `listResolved` filters on `!d.internal`, so none of the three
internal Drive settings appear in `GET /api/settings`, and `set()` rejects writes to them
with `settings.internal_only`. Connection state reaches the client through the storage
status route in section 6 instead.

### Decision 8: no googleapis dependency, plain fetch against the Drive v3 REST API

Seven HTTP calls are needed: token exchange, token refresh, files.create resumable,
files.create multipart, files.get with alt=media, files.delete, and about.get plus a
files.list for the folder. The `googleapis` package pulls in every Google API and is tens
of megabytes. `@googleapis/drive` plus `google-auth-library` is smaller but is still two
dependencies and an auth abstraction we do not need for one grant type.
`DOCMIND-DESIGN.md` sets the precedent with "Own thin adapter layer" for AI providers.

**The cost, stated honestly:** the resumable upload has to be written by hand and it is
the riskiest code in this item. The body length is unknown when the upload starts,
because the size check in `documents.usecases.ts` happens after streaming, so a single
PUT with a Content-Length is not possible. The driver buffers the incoming stream into
fixed 8 MiB chunks and PUTs each with `Content-Range: bytes <start>-<end>/*`, then sends
the final chunk with the real total as `Content-Range: bytes <start>-<end>/<total>`.
Google requires every chunk except the last to be a multiple of 256 KiB, which 8 MiB
satisfies. Memory stays bounded at one chunk. A 308 means continue, 200 or 201 means
done, a 5xx means re-query the session for the committed byte range and resend from
there.

That is roughly 150 lines, and every byte-range decision inside it is pure, so it is unit
testable without a network (section 8). If the reviewer judges the risk too high, the
fallback is `google-auth-library` for tokens plus the same hand-written upload, which
removes the easy part and keeps the hard part. I do not recommend switching to
`googleapis`.

For bodies under 5 MiB the driver uses the simple multipart upload, one request. Since
the size is unknown up front, it reads up to 5 MiB into memory first: if the stream ends
inside that, it does the simple upload; if not, it opens a resumable session and sends
what it already buffered as the first chunks. Most documents are well under 5 MiB, so
most uploads stay one request.

### File naming on Drive

Files go into a folder named by `storage.gdrive.folderName` (default `DocMind`), created
on connect, its id saved in `storage.gdrive.folderId`. Flat inside that folder, not a
`yyyy/mm` tree, because Drive addresses folders by id rather than path, so building the
tree costs a list-or-create round trip per upload for an organisation DocMind never
navigates anyway (the stored key is an id). The Drive file name is the last segment of
the requested key, which is the already sanitized filename, and `appProperties` records
`docmindKey` (the full requested key) and `docmindDocumentId`. Those properties make the
folder legible to a human and are what a future move job would reconcile against.

If the folder id no longer resolves or is trashed, the driver recreates the folder and
updates the setting, logging a warning. That happens when the user deletes the folder by
hand, and failing every upload forever in that case would be hostile.

---

## 3. S3

### Decision 9: @aws-sdk/client-s3 plus @aws-sdk/lib-storage

Two new dependencies. `lib-storage` Upload is the reason for the second: it takes a
`Readable` of unknown length, does multipart automatically with part size and concurrency
controls, and issues AbortMultipartUpload when the stream errors.

**Rejected: aws4fetch.** Tiny, signs correctly, genuinely tempting against a multi-megabyte
SDK. It has no multipart helper, so part orchestration, ETag collection, the
CompleteMultipartUpload XML, and abort-on-error would all be hand-written, plus XML
parsing for ListObjectsV2. SigV4 is one of the places where nearly right produces
failures that are very hard to diagnose.
**Rejected: the MinIO JS client.** Works against AWS too, but it is a third-party
reimplementation and every S3-compatible vendor documents against the AWS SDK.
**Rejected: hand-rolled SigV4.** No.

### S3-compatible endpoints are in scope

MinIO, Cloudflare R2, Backblaze B2, Wasabi and DigitalOcean Spaces are supported and each
named in the guide with its endpoint pattern, its region value, and its path-style
answer. AWS S3 is the default shape: no endpoint, a real region, virtual-host addressing.

### Decision 10: checksum defaults must be turned down for compatibility

Recent AWS SDK versions default to sending a CRC32 checksum header and an
`x-amz-sdk-checksum-algorithm` header on every upload, and to validating response
checksums. Several S3-compatible backends reject or mishandle those headers, which shows
up as an opaque 400 or a signature error on upload against R2, B2 and older MinIO builds.
The client is therefore constructed with:

```
requestChecksumCalculation: "WHEN_REQUIRED",
responseChecksumValidation: "WHEN_REQUIRED",
```

This is the single most likely cause of "it works on AWS and not on my MinIO" and it
deserves a comment in the driver file saying why.

### Decision 11: path-style is an explicit boolean, defaulting to virtual-host

`storage.s3.forcePathStyle`, default false. Virtual-host addressing
(`https://bucket.s3.region.amazonaws.com/key`) is what AWS, R2, B2 and Wasabi want.
Path-style (`https://host/bucket/key`) is what a plain MinIO or a bare-IP deployment
needs. Auto-detecting from the endpoint host was considered and rejected: the heuristic
is wrong for a self-hosted MinIO behind wildcard DNS, and a wrong guess produces a DNS
failure that looks like a network problem rather than a configuration one. The guide
states the value each provider wants, and the test-connection message echoes back which
addressing mode was used, so a mismatch is one click to diagnose.

### Object keys and the prefix

`storage.s3.prefix` (default empty) is joined to the output of `buildStorageKey` with a
single `/`, with leading and trailing slashes normalized away. **The key returned from
`put`, and therefore the key stored on the document row, is the full object key including
the prefix.** Changing the prefix later affects new uploads only and never breaks an
existing document. Same promise as switching drivers, and it follows from the same
property: the stored key is whatever the driver returned.

---

## 4. Settings

All keys follow the existing `storage.<driverId>.<field>` shape, are declared with
`defineSetting` in the driver file next to the driver, and are picked up automatically by
`storage.settings.ts` through the registry flatMap. Env names match the seeds already
listed in `DOCMIND-DESIGN.md` where those exist.

### S3 driver

| Key | Schema | Env | Default | Secret | Required |
|-----|--------|-----|---------|--------|----------|
| `storage.s3.bucket` | non-empty string | `S3_BUCKET` | none | no | **yes** |
| `storage.s3.region` | non-empty string | `S3_REGION` | `us-east-1` | no | **yes** |
| `storage.s3.endpoint` | url or empty | `S3_ENDPOINT` | empty | no | no |
| `storage.s3.forcePathStyle` | boolean | `S3_FORCE_PATH_STYLE` | `false` | no | no |
| `storage.s3.prefix` | string | `S3_PREFIX` | empty | no | no |
| `storage.s3.accessKeyId` | non-empty string | `S3_ACCESS_KEY_ID` | none | no | **yes** |
| `storage.s3.secretAccessKey` | non-empty string | `S3_SECRET_ACCESS_KEY` | none | **yes** | **yes** |

`accessKeyId` is deliberately not marked secret, matching the table in
`DOCMIND-DESIGN.md`. It is an identifier, not a credential, and showing it in full makes
"am I using the right key" answerable without guessing. The secret access key is
encrypted and only ever returned as `{ isSet, lastFour }`.

`requiredSettings: ["storage.s3.bucket", "storage.s3.region", "storage.s3.accessKeyId", "storage.s3.secretAccessKey"]`

### Google Drive driver

| Key | Schema | Env | Default | Secret | Internal | Required |
|-----|--------|-----|---------|--------|----------|----------|
| `storage.gdrive.clientId` | non-empty string | `GDRIVE_CLIENT_ID` | none | no | no | **yes** |
| `storage.gdrive.clientSecret` | non-empty string | `GDRIVE_CLIENT_SECRET` | none | **yes** | no | **yes** |
| `storage.gdrive.refreshToken` | non-empty string | none | none | **yes** | **yes** | **yes** |
| `storage.gdrive.folderName` | non-empty string | `GDRIVE_FOLDER_NAME` | `DocMind` | no | no | no |
| `storage.gdrive.folderId` | non-empty string | none | none | no | **yes** | no |
| `storage.gdrive.connectedEmail` | string | none | none | no | **yes** | no |

`requiredSettings: ["storage.gdrive.clientId", "storage.gdrive.clientSecret", "storage.gdrive.refreshToken"]`

The refresh token has no env seed on purpose. It is produced by the OAuth flow, and
offering an env var for it invites pasting a token from somewhere else into a file on
disk.

### Shared

| Key | Schema | Env | Default | Secret |
|-----|--------|-----|---------|--------|
| `storage.oauth.redirectBaseUrl` | url | `SERVER_BASE_URL` | config serverBaseUrl | no |

Because `defineSetting` resolves env before default, giving this the `SERVER_BASE_URL`
env name makes it track the server base URL automatically while staying overridable from
the UI, which is exactly what decision 6 needs.

### Decision 12: selecting an unconfigured driver is rejected server-side

`createSettingsService` already accepts a `beforeSet` hook, and `server.ts` uses it today
to stop an AI model slot pointing at a provider with no key. The same hook gains a
storage branch, implemented as an exported `assertStorageUpdatesValid` in
`storage.usecases.ts` so the logic is testable outside the server wiring.

Rules:

1. Writing `storage.activeDriver = <id>` checks every key in that driver
   `requiredSettings`. As the AI hook already does, **pending updates in the same batch
   are consulted first**, so "paste the bucket and the secret and switch the driver" in
   one PUT succeeds. Missing keys produce `storage.not_configured`, 409, with the message
   `Google Drive is not fully configured. Missing: client ID, client secret, connection.`
2. Clearing a required credential (`null`, or empty string for a secret) belonging to the
   **currently active** driver is rejected with `storage.driver_in_use`, 409:
   `Switch the active driver away from Amazon S3 before clearing its credentials.`
3. Clearing a required credential of a **non-active** driver that still holds documents
   is **allowed**, with the consequence shown in the UI first.

#### Rule 3 in full: the old rule, the new rule, and why it changed

**Ruled on by the coordinating agent on 2026-09-18, not by the user, and surfaced to
the user in the same session. It stands unless the user says otherwise. Do not revert
it without asking them.**

The old rule, still written in `DOCMIND-DESIGN.md` under "Switching drivers": the UI
"shows how many documents each driver holds and refuses to clear credentials for a
driver that holds any".

The new rule: **refuse only for the active driver. Allow it for any inactive driver,
behind a confirm that names the document count.**

Why it changed. The old rule traps the user permanently. Once a single document has been
written to a driver, that driver credentials could never be removed again, not after the
bucket is deleted, not after the Google account is closed, not after the keys leak. The
failure the old rule prevents is that a document becomes temporarily undownloadable. The
failure it causes is a credential the user can never remove from their own install. The
second is worse, and it is permanent. Clearing a credential destroys nothing: the
documents stay in the library, stay searchable, stay chattable, stay citable in chat, and
downloading works again the moment the credential is re-entered. So the refusal buys
safety that is not real.

Keeping the refusal for the **active** driver is different and stays, because clearing
the active driver credentials breaks the next upload rather than an old download, and
the fix is one click: switch the active driver first.

**`DOCMIND-DESIGN.md` still says otherwise and needs the same edit when this item is
implemented.** That edit is task 9 in the task order below. This spec does not change the
design doc.

#### The confirm dialog copy

This copy is the only thing between the user and a document they cannot open, so it is
specified here rather than left to the implementer.

Title: `Clear Google Drive credentials?`

Body, when the driver holds at least one document, with the count in the first sentence
and the consequence in the second:

> Google Drive holds 412 documents. Those documents stay in your library and stay
> searchable, but you will not be able to download or preview them until you enter these
> credentials again.

Singular form when the count is 1: `Google Drive holds 1 document.` Never render
`1 documents`. When the driver holds no documents the count sentence is dropped entirely
and the body is:

> DocMind will forget the saved client secret and the connection to your Google account.
> You can connect again at any time.

Confirm button: `Clear credentials`. Cancel button: `Cancel`. The confirm button is
destructive styling. No typed confirmation is required, because nothing is deleted and
the action is reversible by re-entering the credential.

The same dialog, with the driver label swapped, covers the S3 Clear action and the Drive
Disconnect action.

### UI behaviour for a selected but unconfigured driver

- The active driver control is a list of radio options, one per driver. An option whose
  `configured` is false is **disabled**, with a line under it reading
  `Needs: bucket, secret access key` built from the status route `missingSettings`, and a
  link that scrolls to that driver card.
- The server-side guard in decision 12 is the real enforcement. The disabled option is a
  convenience, not the check, because a required env var can vanish between page load and
  click.
- If the **active** driver becomes unconfigured out of band (env var removed, credentials
  cleared through another path), the Storage tab shows a red banner at the top:
  `Uploads are failing. The active driver, Google Drive, is not connected.` Uploads fail
  with `storage.not_configured`, 409, and the upload UI shows that message rather than a
  generic error. This matters: an unconfigured active driver is silently fatal today.
- Each driver card shows a `Holds N documents` line whenever N is above zero, for every
  driver, active or not. That is the count the design doc asks for and it is what makes
  the disconnect dialog honest.

---

## 5. Switching the active driver, and orphaned drivers

### Decision 13: no migration. Documents stay exactly where they are.

Not a new decision so much as a confirmation that the code already behaves this way,
checked before choosing:

- `documents.usecases.ts` lines 56 to 57 resolve the active driver **at upload time** and
  write `storageDriver: driverId` onto the row.
- Line 166 (delete) and line 173 (download) both call
  `storageService.getDriver(userId, document.storageDriver)`, the driver on the row, not
  the active one.
- `export.usecases.ts` line 42 does the same.
- `storage.usecases.ts` `getActiveDriverId` reads `storage.activeDriver` with a local
  fallback and is used only by the upload path.

So switching from local to S3 means new uploads go to S3 and every older document keeps
being read off disk. Nothing moves, nothing breaks, no job runs. Moving documents is
feature item #30 and stays there.

### The honest behaviour when a document driver is no longer usable

Three distinct situations, each with a different answer.

1. **Driver not active but still configured.** Everything works: download, delete,
   export, re-extraction all resolve the old driver and succeed. This is the normal case
   after a switch and needs no user-facing anything.
2. **Driver not configured** (credentials cleared, env removed, Drive disconnected).
   `definition.create` throws `storage.not_configured`. The consequences, spelled out
   because the user will hit this:
   - The document stays in the library with its name, tags, category, type, smart fields,
     extracted text, summary and embeddings. All of that lives in SQLite.
   - Keyword search, vector search and chat still find it and still cite it, because none
     of them touch the blob.
   - **Download and preview fail** with 409 and the message `This document is stored on
     Google Drive, which is not connected. Reconnect it in Settings, Storage.` The
     document detail page shows that inline instead of a raw error.
   - Export skips it. `export.usecases.ts` already catches per-document storage failures
     and continues; this item additionally records the skipped documents in the export
     manifest rather than silently omitting them.
   - **Delete must still work.** Today `deleteDocument` calls `driver.delete` before the
     row update, so an unreachable driver makes the document undeletable. This item
     creates the conditions for that bug, so this item fixes it: wrap the storage delete
     in a try/catch, log a warning with the document id, driver and key, and proceed. The
     blob is then orphaned on the remote, which is the lesser evil, and the warning line
     is the record.
3. **Driver id not in the registry at all.** Only reachable by downgrading after using a
   driver, since the registry is compiled in. `storage.unknown_driver`, 400, already
   handled.

---

## 6. Test connection

### Route

`POST /api/storage/drivers/:id/test`, in a new
`apps/server/src/modules/storage/storage.routes.ts`, behind the session middleware,
mirroring `POST /api/ai/providers/:id/test` exactly. The driver id is validated with a
valibot `picklist(storageDriverIds)` through `parseOrValidationError`.

### Return shape

```ts
{ ok: boolean; latencyMs: number; message: string }
```

Identical to the AI module TestResult, on purpose: the test button and the result line
then become one shared client component across the AI and Storage tabs. `latencyMs` is
measured around the whole check. On failure the message always ends with the provider
error text.

The route never throws for a failed connection. A failed check is `{ ok: false }` with a
200, so the client renders the message inline rather than as a toast. It throws only for
an unknown driver id or a missing session.

### Companion route

`GET /api/storage/drivers` returns everything the Storage tab needs in one call:

```ts
{
  activeDriverId: string;
  drivers: Array<{
    id: string;
    label: string;
    guide: SetupGuide;
    configured: boolean;
    missingSettings: string[];   // human labels derived from requiredSettings
    documentCount: number;
    requiresOauth: boolean;
    redirectUri?: string;        // oauth drivers only, for the copy button
    connection?: { connected: boolean; accountLabel?: string; lastAuthError?: string };
  }>;
}
```

`documentCount` needs a new `countByDriver({ userId })` in `documents.repository.ts`, a
single grouped Drizzle select. `lastAuthError` comes from the in-memory record described
in section 7 and is intentionally not persisted.

A third route, `POST /api/storage/drivers/:id/disconnect`, clears the OAuth settings for
a driver. It exists separately from `PUT /api/settings` because the refresh token is
internal and cannot be cleared through the settings API by design.

### What the test does per driver

**Local.** Unchanged, the existing healthCheck: create the root if missing, write a
`.docmind-health` probe, delete it. Message: `Writable: /var/lib/docmind/documents`.

**S3.** Three steps, so the common failures are each distinguishable.

1. HeadBucket. On 403, fall back to ListObjectsV2 with `MaxKeys: 1` and the configured
   prefix, because a Backblaze application key scoped to one bucket, and some
   least-privilege IAM policies, deny HeadBucket while allowing everything DocMind needs.
2. PutObject of a nine-byte probe at `<prefix>.docmind-health`, then GetObject it, then
   DeleteObject it. **This is the important step.** A passing HeadBucket proves the
   bucket exists and the credentials are valid and proves nothing about write permission,
   which is the failure users actually hit. Testing the real thing is worth one tiny
   object.
3. The success message names what was verified, so a misconfiguration is visible at a
   glance: `Read and write OK. Bucket docmind-files, region auto, endpoint
   https://xxx.r2.cloudflarestorage.com, virtual-host addressing.` A failure reads
   `HeadBucket failed (403 AccessDenied): <provider text>`.

**Google Drive.** Read-only, three steps.

1. Refresh the access token. This is the check that matters, since a revoked or expired
   grant is the dominant Drive failure and it surfaces here as `invalid_grant`.
2. `GET /drive/v3/about?fields=user(emailAddress),storageQuota`.
3. `GET /drive/v3/files/{folderId}?fields=id,name,trashed`. If the folder is gone or
   trashed, recreate it, update `storage.gdrive.folderId`, and say so in the message.
4. Message: `Connected as you@example.com. Folder DocMind. 87.2 GB of 100 GB free.`

No probe upload for Drive, unlike S3. Under the drive.file scope any file the app created
is writable by the app by construction, so a write probe tests nothing the token refresh
has not already tested, and it would leave a file in the user Drive trash every time the
button is pressed.

---

## 7. Failure modes

Every row below is a real thing that happens, with the code it maps to and the exact
user-facing consequence. Uploads and downloads are synchronous inside the HTTP request
today, so those failures reach the browser directly. Extraction, embedding and summary
read the blob inside a job, so those failures land on the job and inherit the runner
three attempts with backoff.

| Situation | Driver | Mapped to | What the user sees |
|---|---|---|---|
| Refresh token revoked or expired (`invalid_grant`) | gdrive | `storage.auth_expired` 401 | Upload or download shows `Google Drive needs to be reconnected.` The Storage tab shows a red Reconnect button on the Drive card, driven by `lastAuthError`. |
| Consent screen left in Testing, token dies after 7 days | gdrive | same | Same, plus the guide note explaining the seven-day rule and telling them to publish the app. |
| Drive full (`storageQuotaExceeded`) | gdrive | `storage.quota` 507 | `Your Google Drive is full. Free some space or switch the active storage driver.` |
| `rateLimitExceeded` or `userRateLimitExceeded` 403, or a 429 | gdrive | `storage.rate_limited` 429 | The driver retries internally up to 3 times with exponential backoff and jitter starting at 1 s. If it still fails: `Google Drive is rate limiting requests. Try again in a minute.` Jobs then retry on their own schedule. |
| Access keys wrong (`InvalidAccessKeyId`, `SignatureDoesNotMatch`) | s3 | `storage.auth_expired` 401 | `S3 rejected the credentials: SignatureDoesNotMatch.` Test connection gives the same text. |
| Bucket missing or denied (`NoSuchBucket`, `AccessDenied`) | s3 | `storage.not_configured` 409 | `Bucket docmind-files: AccessDenied. Check the bucket name, the region, and the key policy.` |
| Wrong addressing mode for the endpoint | s3 | `storage.network` 502 | The DNS failure text plus a hint the driver appends: `If this endpoint is MinIO, turn on path-style addressing.` The hint exists because the raw ENOTFOUND on `bucket.host` does not point at the cause. |
| `SlowDown` or 503 | s3 | `storage.rate_limited` 429 | The SDK retries first (`maxAttempts: 4`), then the message above. |
| Connect timeout, DNS failure, connection reset | both | `storage.network` 502 | `Could not reach Google Drive: connect ETIMEDOUT.` The S3 client is built with `connectionTimeout: 5000` and `requestTimeout: 60000`. Drive metadata calls use `AbortSignal.timeout(30_000)`, and each upload chunk request gets its own 120 s timeout, which bounds a stalled transfer without killing a slow but live one. |
| Partial upload, stream errors mid-transfer | s3 | `storage.remote_error` 502 | lib-storage Upload issues AbortMultipartUpload on failure. A hard process crash can still strand parts, which cost money silently and which DocMind cannot clean up afterwards, so the S3 guide carries a copyable lifecycle rule: abort incomplete multipart uploads after 7 days. |
| Partial upload, stream errors mid-transfer | gdrive | `storage.remote_error` 502 | The driver deletes the file id if the session already produced one. Otherwise the abandoned resumable session expires on the Google side within a week. No user action. |
| Oversize upload, over 100 MB | both | `documents.too_large` 413 | Unchanged, but note the cost: `documents.usecases.ts` streams the whole body to storage **before** checking the size, then deletes it. On a remote driver that means paying the full upload plus a delete for a file that gets rejected. Known limitation, not fixed here; fixing it properly means buffering to a temp file or trusting Content-Length, each its own change. |
| Duplicate content hash | both | not an error | Same story: the blob is uploaded, then deleted, then the existing document is returned. One extra round trip per duplicate on a remote driver. Accepted. |
| Active driver unconfigured | both | `storage.not_configured` 409 | Covered in sections 4 and 5. |

### Decision 15: lastAuthError is in memory and nothing is auto-deleted

`lastAuthError` is a module-level `Map<driverId, { at: string; message: string }>` in
`storage.usecases.ts`, written whenever a driver throws `storage.auth_expired` and
cleared on any successful driver call or successful test. It resets on restart, which is
fine: the next failing call repopulates it, and the alternative is a settings write on
every auth failure.

The refresh token is **never** deleted automatically on an auth failure, because a
transient Google outage returning 401 would otherwise silently disconnect the user
storage. Disconnecting stays a deliberate user action.

---

## 8. Testing

### The shared contract suite

`apps/server/src/modules/storage/drivers/driver-contract.test-utils.ts` keeps its four
existing tests (put/exists/get/delete, missing key is not found, health check passes,
8 MB body streams) and gains four more, all driver-agnostic per decision 3.

1. **The returned key is authoritative.** Put with a requested key, then `exists`, `get`
   and `delete` using only the returned key. Assert the round trip, and do not assert
   that the returned key equals the requested one.
2. **Delete is idempotent.** Delete a never-written key, then delete an already-deleted
   key. Neither throws.
3. **A binary body round trips**, including bytes above 0x7f, so a driver that
   accidentally does a utf8 conversion fails here.
4. **Keys with spaces, dots and non-ASCII characters** in the final segment round trip.

Every new test is written against the local driver first and must pass unchanged, which
proves the suite did not accidentally encode S3 or Drive semantics.

### What runs without real credentials

All of this is a normal `pnpm test` run.

- **Local driver:** the full contract suite, as today.
- **S3 pure logic** in `drivers/s3/s3.models.ts`: prefix joining and normalization,
  endpoint normalization, the client config assembled from settings (asserted as a plain
  object, no client constructed), and the error mapper from an SDK-shaped error
  (`{ name, $metadata: { httpStatusCode } }`) to an AppError code. Those cover decisions
  10 and 11 and most of the S3 rows in section 7.
- **S3 contract suite against MinIO**, gated on `S3_TEST_ENDPOINT`. When it is absent the
  suite is `describe.skip`ped with a printed note naming the env var, so it is
  discoverable rather than invisible. A throwaway MinIO compose snippet goes in the plan.
- **Google Drive pure logic** in `drivers/gdrive/gdrive.models.ts`: the Content-Range
  header for a middle chunk and for a final chunk, the choice between simple and
  resumable upload given a buffered prefix, token expiry math including the 60 s skew,
  the Google error JSON to AppError mapping (`invalid_grant`, `storageQuotaExceeded`,
  `rateLimitExceeded`, plain 404, 5xx), the authorize URL builder, and the Drive file
  name derived from a storage key.
- **OAuth state** sign and verify: round trip, tampered payload rejected, expired state
  rejected, state signed for one driver rejected on another driver callback. The signing
  key is derived from `SETTINGS_ENCRYPTION_KEY` with HKDF and the label `oauth-state`,
  as `DOCMIND-DESIGN.md` specifies, with a ten minute expiry.
- **Decision 16: Google Drive driver against a stubbed fetch.** `createGdriveDriver` and
  the OAuth usecases take an injected `fetchImpl` defaulting to `globalThis.fetch`, and
  the S3 driver takes an injected client factory. With that, the full contract suite runs
  against Drive with a scripted fetch implementing an in-memory Drive: token refresh,
  resumable session creation, chunk PUTs with range bookkeeping, get, delete. That fake
  is real work, perhaps 150 lines, and it is worth it because it is the only way to test
  the chunking loop end to end without a Google account, and the chunking loop is where
  the bugs will be.
- **Settings:** `setInternal` writes ciphertext for a secret definition and the round
  trip returns plaintext (decision 7). `assertStorageUpdatesValid` accepts a batch that
  sets credentials and the active driver together, rejects a switch to an unconfigured
  driver while naming the missing keys, and rejects clearing the active driver
  credentials (decision 12).
- **Routes**, integration style against in-memory SQLite like the other route tests:
  `GET /api/storage/drivers` shape and document counts, `POST /api/storage/drivers/:id/test`
  with a stub driver returning ok and not-ok, unknown driver id rejected, and the OAuth
  callback against a stubbed token endpoint including a replayed and an expired state.
- **Documents:** delete succeeds when the driver throws `storage.not_configured`, with
  the row marked deleted. That is the regression test for the bug named in section 5.
- **Client:** the Storage tab renders a card per driver, disables an unconfigured driver
  radio option and names the missing settings, shows the document count, shows Connect
  versus Reconnect versus Disconnect for Drive based on `connection.connected` and
  `lastAuthError`, and shows the red banner when the active driver is unconfigured.

### What must be manual

Listed so the plan can carry it as a checklist. None of it can be honestly automated
here.

1. The real Google consent screen, first connect, and the redirect URI matching.
2. Access token refresh after the first hour, verified by uploading, waiting, then
   downloading.
3. Revoking DocMind from the Google account third-party access page, confirming the
   Reconnect state appears, and reconnecting to restore service.
4. A real upload over 5 MiB and one near 100 MB to Drive, to exercise the resumable path
   and the chunk boundaries against Google rather than against the fake.
5. One real bucket on each of Cloudflare R2, Backblaze B2 and AWS S3: create, test
   connection, upload, download, delete. This is where decision 10 (checksums) and
   decision 11 (addressing) actually get validated.
6. Switching the active driver with documents already in the library, then downloading an
   older document from the previous driver.
7. Clearing a non-active driver credentials while it still holds documents, confirming
   the library, search and chat still work and that download shows the right message.

---

## Bug found in shipped code: setInternal stores a secret setting in plaintext

This is written up as a bug rather than as a prerequisite, because it is a defect in code
that is already on `main`, and it should get a `docs/bugs_fix_tracking.md` record through
the normal bug fix workflow rather than riding in quietly as part of a feature.

**Where.** `apps/server/src/modules/settings/settings.usecases.ts`, `setInternal`, lines
170 to 178, with the read side at line 61.

```ts
async setInternal(userId: string, key: string, value: unknown) {
  const definition = registry.get(key);
  if (!definition.internal) {
    throw new Error(`setInternal called on non-internal setting "${key}"`);
  }
  const parsed = parseOrThrow(definition, value);
  await repository.upsert({ userId, key, isSecret: false, value: JSON.stringify(parsed) });
  cache.delete(userId);
}
```

**What breaks.** `setInternal` hard-codes `isSecret: false` and JSON-stringifies the
value, ignoring `definition.secret` entirely. `set()`, ten lines above, does the opposite
for the same case: it calls `encryptSecret` and writes `isSecret: true`. So a setting
declared `{ secret: true, internal: true }` fails twice over:

1. **Write.** The plaintext secret is written to the `settings` table as a JSON string.
   It is now at rest, unencrypted, in the database file and in every backup of it. This
   is the part that matters. It silently violates the rule in `CLAUDE.md` that secrets
   are encrypted at rest.
2. **Read.** `resolveRaw` (line 61) branches on `definition.secret`, not on the stored
   `is_secret` column: `if (definition.secret) return { value: decryptSecret(...) }`. So
   it hands the JSON string to `decryptSecret`, which sees no `enc:v1` prefix and throws
   `settings.bad_ciphertext`, whose message is "Stored secret could not be decrypted. Was
   SETTINGS_ENCRYPTION_KEY changed?". That message would send the debugger straight at
   the encryption key, which is not the problem at all.

**Severity today.** Latent, not currently firing. Nothing in the tree combines the two
flags: `search.activeDimension` (`search.usecases.ts:90`) is a number and
`types.presetsSeeded` (`tags.usecases.ts:218`) is a boolean, both non-secret. So no
secret is in plaintext on any existing install. The defect is that the next person to
declare a secret internal setting gets a silent plaintext write and a misleading error,
and this item is that next person: the Google Drive refresh token is exactly that
setting.

**The fix.** `setInternal` mirrors the secret branch of `set()`: when
`definition.secret` is true, encrypt with `encryptSecret` and upsert with
`isSecret: true`. It also gains the clear path that `set()` has, where a `null` value
removes the row, which Disconnect needs. No change to `resolveRaw` is required once the
write side is correct, and no migration is required because no such row exists.

**The regression test**, which must be written first and watched to fail against the
current code, per the bug fix workflow in `CLAUDE.md`:

- Register a definition with `{ secret: true, internal: true }`.
- Call `setInternal`, then read the raw row through the existing `debugRows` helper and
  assert the stored value starts with `enc:v1:` and that `is_secret` is 1.
- Call `get` and assert the plaintext comes back, which fails today with
  `settings.bad_ciphertext`.
- Call `setInternal` with `null` and assert the row is gone and the value falls back to
  env or default.
- Assert `listResolved` still omits it, and that `set()` still rejects it with
  `settings.internal_only`, so the fix does not widen the API surface.

This is task 1 in the order below, and it should be proposed to the `bug-fix-record`
agent once fixed.

---

## Decisions list

1. `StorageDriver` does not change. The returned-key contract already handles opaque
   remote ids, and streaming already works in both directions.
2. `StorageDriverDefinition` gains `requiredSettings`, an optional `oauth` block, and the
   `StorageOauthDefinition` type. The local driver adds one line.
3. Three contract clarifications become tests: the returned key is authoritative, delete
   is idempotent, keys are opaque strings and not paths.
4. A shared `storage.errors.ts` with ten codes. Provider error text is always appended
   verbatim, and secrets never appear in a message.
5. Google Drive uses user OAuth with a stored refresh token and the drive.file scope.
   Rejected: a service account plus a shared folder, because a service account has no
   Drive quota and the resulting files are not owned by the user.
6. `storage.oauth.redirectBaseUrl` is its own setting defaulting to `SERVER_BASE_URL`,
   because the tunnel workflow otherwise makes the callback unreachable.
7. `settings.setInternal` is fixed to encrypt secret definitions and to support clearing.
   Today it hard-codes `isSecret: false`, which would store the refresh token in
   plaintext and then fail to read it back.
8. No googleapis dependency. Plain fetch against the Drive v3 REST API, with a
   hand-written chunked resumable upload. Cost acknowledged: that loop is the riskiest
   code in the item, so it is split into pure helpers and covered by a fetch fake.
9. S3 uses `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`. Rejected: aws4fetch (no
   multipart helper, hand-rolled XML), the MinIO client (third-party reimplementation),
   hand-rolled SigV4.
10. The S3 client sets `requestChecksumCalculation` and `responseChecksumValidation` to
    `WHEN_REQUIRED`, because the newer SDK defaults break R2, B2 and older MinIO.
11. `storage.s3.forcePathStyle` is an explicit boolean defaulting to false. Rejected:
    inferring it from the endpoint host, because a wrong guess produces a DNS error that
    does not point at the cause.
12. Selecting an unconfigured driver is rejected server-side through the existing
    `beforeSet` hook, consulting pending updates in the same batch. Clearing the active
    driver credentials is rejected. Clearing an inactive driver credentials is allowed
    behind a confirmation, a deliberate departure from the design doc blanket refusal,
    ruled on by the coordinating agent on 2026-09-18 and surfaced to the user, not
    ruled on by the user. `DOCMIND-DESIGN.md` needs the matching edit.
13. Switching drivers migrates nothing, verified against the code rather than assumed. A
    document on an unconfigured driver stays searchable and chattable and fails only on
    download, and deleting it must still work, which needs a small fix in
    `documents.usecases.ts`.
14. Test connection lives at `POST /api/storage/drivers/:id/test`, returns the AI module
    TestResult shape, and returns 200 with `ok: false` for a failed connection. S3 writes
    and deletes a probe object because HeadBucket does not prove write access. Drive
    stays read-only because the token refresh is the real test.
15. `lastAuthError` is in memory per driver, never persisted, and a refresh token is
    never deleted automatically on an auth failure.
16. Network calls go through an injected `fetchImpl` (Drive) or an injected client
    factory (S3), so the shared contract suite can run against a fake.

---

## File structure

New and changed files, paths from the repository root.

```
apps/server/src/modules/storage/
  storage.types.ts                          CHANGED  requiredSettings, oauth, StorageOauthDefinition
  storage.registry.ts                       CHANGED  register s3 and gdrive
  storage.settings.ts                       CHANGED  add storage.oauth.redirectBaseUrl
  storage.usecases.ts                       CHANGED  listDriverStatus, testDriver,
                                                     assertStorageUpdatesValid, lastAuthError
  storage.errors.ts                         NEW      the mapped code set
  storage.routes.ts                         NEW      GET /api/storage/drivers,
                                                     POST /api/storage/drivers/:id/test,
                                                     POST /api/storage/drivers/:id/disconnect
  storage.oauth.routes.ts                   NEW      start and callback, registered pre-session
  storage.oauth.models.ts                   NEW      state sign and verify, authorize URL
  storage.oauth.usecases.ts                 NEW      code exchange, token refresh, disconnect
  storage.schemas.ts                        NEW      driver id picklist, callback query schema
  drivers/driver-contract.test-utils.ts     CHANGED  four new contract tests
  drivers/local/local.driver.ts             CHANGED  requiredSettings: []
  drivers/s3/s3.driver.ts                   NEW
  drivers/s3/s3.models.ts                   NEW      pure: keys, client config, error mapping
  drivers/s3/s3.guide.ts                    NEW
  drivers/s3/s3.models.test.ts              NEW
  drivers/s3/s3.driver.test.ts              NEW      contract suite, gated on S3_TEST_ENDPOINT
  drivers/gdrive/gdrive.driver.ts           NEW
  drivers/gdrive/gdrive.models.ts           NEW      pure: ranges, expiry, error mapping
  drivers/gdrive/gdrive.api.ts              NEW      fetch wrappers for the Drive calls
  drivers/gdrive/gdrive.tokens.ts           NEW      module-scoped access token cache
  drivers/gdrive/gdrive.guide.ts            NEW
  drivers/gdrive/gdrive.models.test.ts      NEW
  drivers/gdrive/gdrive.driver.test.ts      NEW      contract suite against the fetch fake
  drivers/gdrive/gdrive.fetch.test-utils.ts NEW      the in-memory Drive fake

apps/server/src/modules/settings/
  settings.usecases.ts                      CHANGED  setInternal encrypts secrets, supports clear
  settings.usecases.test.ts                 CHANGED

apps/server/src/modules/documents/
  documents.repository.ts                   CHANGED  countByDriver
  documents.usecases.ts                     CHANGED  delete tolerates an unreachable driver
  documents.usecases.test.ts                CHANGED

apps/server/src/modules/export/
  export.usecases.ts                        CHANGED  record skipped documents in the manifest

apps/server/src/server.ts                   CHANGED  storage branch in beforeSet, register routes
apps/server/package.json                    CHANGED  two new dependencies
apps/server/.env.example                    CHANGED  S3 and GDRIVE seeds

apps/client/src/pages/settings/
  SetupGuide.tsx                            NEW      extracted from ProviderCard
  ProviderCard.tsx                          CHANGED  use SetupGuide
  StorageTab.tsx                            REWRITTEN driver cards, active driver selector
  StorageDriverCard.tsx                     NEW
  StorageTab.test.tsx                       REWRITTEN
  StorageDriverCard.test.tsx                NEW
apps/client/src/lib/storage-api.ts          NEW

DOCMIND-DESIGN.md                           CHANGED  storage section: credential clearing rule,
                                                     redirect base URL setting
docs/FEATURES.md                            CHANGED  item 9 progress
```

No `*.tables.ts` changes anywhere. **No migration is needed for this item.** The one
database-shaped thing, the refresh token, goes into the existing `settings` table through
its existing key/value shape, which is exactly what that table is for.

---

## Suggested task order

Nine independently committable tasks, each leaving the tree working and tested. A full
plan with interfaces, test strategy and commit messages comes next; this is the shape.

1. **Settings: encrypt internal secrets.** Fix `setInternal`, add the clear path, add
   tests. Everything Google Drive does depends on this.
2. **Storage contract: types, errors, tests.** `requiredSettings`, the oauth type,
   `storage.errors.ts`, the four new contract tests, the local driver updated. Pure
   groundwork, no new driver.
3. **Documents and export resilience.** `countByDriver`, delete tolerates an unreachable
   driver plus its regression test, export manifest records skips.
4. **Storage status and test routes.** `storage.routes.ts`, `listDriverStatus`,
   `testDriver`, `assertStorageUpdatesValid` wired into `beforeSet`, route tests with a
   stub driver. Only the local driver exists at this point, and it now has an API behind
   a Test button.
5. **S3 driver.** Models, driver, settings, guide, registry entry, unit tests, contract
   suite gated on MinIO. The two new dependencies land here.
6. **Client: shared guide component and the new Storage tab.** Extract `SetupGuide`,
   rewrite `StorageTab` into driver cards with the active driver selector, disabled
   unconfigured options, document counts, the test button and the red banner. After this
   task S3 is usable end to end from the UI.
7. **Google Drive driver.** OAuth models, token cache, API wrappers, the driver with both
   upload paths, settings, guide, registry entry, the fetch fake, the contract suite,
   unit tests. The largest task by far. The plan should consider landing the pure models
   and the fake ahead of the driver itself.
8. **Google Drive OAuth routes and the client connect flow.** Start and callback
   registered before the session middleware, folder creation on connect, disconnect, the
   redirect URI copy button, Connect, Reconnect and Disconnect in the card.
9. **Docs.** `.env.example` seeds, `docs/FEATURES.md`, and the two `DOCMIND-DESIGN.md`
   storage amendments: the credential clearing rule (the design doc still says the UI
   refuses for any driver holding documents, and must be changed to refuse only for the
   active driver) and the new `storage.oauth.redirectBaseUrl` setting.

### One route detail worth pinning down in the plan

The OAuth callback arrives as a top-level browser navigation from Google, not as an XHR.
`server.ts` applies `app.use("/api/*", sessionMiddleware(auth))` before the feature
routes, so a callback registered after it would require a session cookie to survive a
cross-site redirect. Decision: **the callback trusts only the signed state value** and is
registered alongside `registerAuthRoutes`, before the session middleware. The state
carries the user id and the driver id and is HMAC-signed with the HKDF-derived key, so
it is the stronger check anyway. The start route stays behind the session middleware,
because that is where the user id comes from.

---

## Verification

Before this spec is considered implemented:

- `pnpm typecheck` and `pnpm test` pass from the root.
- The shared contract suite passes for local, for S3 against a local MinIO, and for
  Google Drive against the fetch fake.
- `GET /api/settings` contains no `storage.gdrive.refreshToken`, no `folderId`, no
  `connectedEmail`, and returns `storage.s3.secretAccessKey` only as
  `{ isSet, lastFour }`.
- A raw `select value from settings where key = 'storage.gdrive.refreshToken'` returns a
  string starting with `enc:v1:`.
- Switching the active driver to a half-configured driver returns 409 and names the
  missing keys. Switching with the credentials in the same PUT succeeds.
- A document uploaded under the local driver still downloads after the active driver has
  been switched to S3.
- A document on a disconnected driver still appears in the library and in search, shows
  the reconnect message on download, and can still be deleted.
- Clearing the credentials of an inactive driver that holds documents shows the confirm
  copy in section 4 with the right singular or plural, and succeeds. Clearing the active
  driver credentials returns 409.
- The `setInternal` regression test fails against the current code and passes after the
  fix, and the fix is proposed to the `bug-fix-record` agent.
- The seven manual checks in section 8 are run and recorded in the worklog.

---

## Rulings

Decisions settled by someone other than the spec author, and decisions where a
reasonable person would have chosen the other way. Recorded so a later reader knows they
were deliberate.

- **Ruled by the user, 2026-09-18: clearing credentials for a driver that still holds
  documents is allowed.** Refuse only for the active driver; allow it for any inactive
  driver behind a confirm that names the document count. The old blanket refusal in
  `DOCMIND-DESIGN.md` traps the user forever after a single upload, which is a worse and
  more permanent failure than a temporarily undownloadable document. The design doc needs
  the matching edit when this item is implemented, see decision 12 and task 9.
- **A reasonable person would have used `googleapis` or `@googleapis/drive`** instead of
  hand-writing the chunked resumable upload against plain fetch (decision 8). The chunk
  and byte-range loop is the single riskiest piece of code in this item and a library
  would remove it. Chosen against because the package is enormous for six endpoints and
  because `DOCMIND-DESIGN.md` already sets the thin-adapter precedent, and mitigated by
  splitting every range decision into pure functions plus an in-memory Drive fake that
  runs the whole contract suite. If the implementer hits trouble here, swapping in
  `@googleapis/drive` is a legitimate reversal, not a failure.
- **A reasonable person would have made the S3 test connection read-only**, like the
  Drive one. Chosen to write and delete a probe object instead, because HeadBucket
  passing while PutObject is denied is the single most common S3 misconfiguration and a
  read-only test would report a green light on a bucket that cannot accept an upload.
  The cost is one nine-byte object written and deleted per button press.
- **A reasonable person would have marked `storage.s3.accessKeyId` secret.** Left
  non-secret, matching the table already in `DOCMIND-DESIGN.md`, because it is an
  identifier rather than a credential and masking it makes "am I using the right key"
  unanswerable from the UI. The secret access key is encrypted as normal.
- **A reasonable person would have persisted the Google access token.** Kept in process
  memory only (decision 5 and its table), because it means no hourly database write and
  because an hour-lived token at rest buys nothing next to the refresh token that mints
  it. The cost is a token exchange after every server restart.
- **A reasonable person would have auto-cleared the refresh token on an auth failure**,
  so the UI state matches reality. Chosen not to (decision 15), because a transient
  Google 401 would then silently disconnect the user storage and require a full
  reconnect. The in-memory `lastAuthError` drives the Reconnect prompt instead, and
  disconnecting stays a deliberate user action.
- **A reasonable person would have added a move-documents job to this item**, since
  switching drivers leaving old documents behind will surprise someone. Left out because
  it is already feature item #30 with its own scope, and because the per-row driver
  resolution already in the code makes leaving them behind safe rather than broken. The
  honest consequences are spelled out in section 5.
- **Not ruled, accepted as a known limitation:** the upload path streams the entire body
  to storage before checking the size limit and before checking for a duplicate hash, so
  a remote driver pays a full upload plus a delete for a file that is then rejected. Real
  cost on a metered connection, fixable only by buffering to a temp file or trusting
  Content-Length, both of which are their own change. Section 7 records it.
