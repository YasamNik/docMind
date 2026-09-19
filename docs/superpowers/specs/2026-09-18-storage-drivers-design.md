# Storage drivers: S3-compatible and Google Drive

Date: 2026-09-18
Feature list item: #9 (S3, Drive, OneDrive storage), plus the storage settings surface the
local driver left unfinished.

## Why

Every uploaded file goes through a storage driver, but only `local` exists. The driver
contract, the registry, per-driver settings and the setup guide type are all in place and
used by nothing else. This adds S3-compatible object storage and Google Drive, and builds
the settings surface both need.

## What the user asked for

In the user's words, across four messages:

- "When you switch to any other storage it become active instead of local."
- "Each record will have where it's stored. And whenever you switch to, you will see the
  storage and files and interaction will be with that location."
- "the ai search and chat will see all the stored documents and chat will tell you that
  you may say that you have that document but in the different storage"
- "It knows all the metadata about all files, but cannot show files from other storages,
  but can tell where to find the original file"

One active storage. The library shows that storage. Knowledge is never scoped: search and
chat see every document, name the storage a document lives on, and can point at the
original file.

## Current state, verified in the code

- `documents.storage_driver` and `documents.storage_key` already exist and are NOT NULL
  (`documents.tables.ts:12-13`). **No migration is needed.**
- Upload writes to the active driver and records its id (`documents.usecases.ts:56`).
  Download, delete and export resolve the driver from the document's own row
  (`documents.usecases.ts:166,173`, `export.usecases.ts:42`).
- `StorageDriverDefinition` carries `settings` and a `guide`; `StorageDriver` carries
  `healthCheck()`. No route exposes either.
- `StorageTab.tsx:18` renders every `storage.*` setting as a bare input. No picker, no
  guide, no test.
- `buildViewConditions` in `documents.repository.ts` is the shared filter behind the list,
  trash and counts. It is **also** behind the rules rerun (`rules.usecases.ts:122,499`),
  summary backfill (`summary.usecases.ts:121`) and `reembedAll`
  (`search.usecases.ts:265`), which matters for section 1.

## Design

### 1. The library is scoped, knowledge is not

`storage.activeDriver` becomes the storage you are looking at, not only where new uploads
land. Exactly three things change:

**Scoped to the active driver:** the documents list, the trash list, and the counts that
feed them. One `storageDriver` clause, applied in the list usecases rather than inside
`buildViewConditions`, because that helper is shared with background maintenance.

**Never scoped:** search, chat retrieval, export, and every background job (rule reruns,
summary backfill, re-embedding). Maintenance must keep working on documents whose storage
is not currently active, or a switch would quietly stop the library maintaining itself.
This is why the clause goes in the usecases and not the shared helper: adding it to
`buildViewConditions` would have silently skipped those jobs.

**Blocked, with an explanation:** fetching the bytes. `openFile` compares the document's
`storageDriver` to the active driver and, when they differ, fails with a message naming
the storage and the original's location rather than reading through the inactive driver.
Deleting the file has the same guard. Restoring from trash does not: it only moves
metadata.

What the user sees:

- The documents page shows "Showing documents on Amazon S3" with the count held on other
  storages beside it, so a document missing from the list is explained on the page.
- A search result or chat citation for a document elsewhere carries a badge naming its
  storage.
- The chat system prompt gains one instruction: when a cited document is on a storage that
  is not active, say so in the answer and give its location instead of implying it can be
  opened.
- A document detail page always opens in full: text, summary, smart fields, tags, history.
  Only the preview and download are replaced, by the original's location (section 1a).

**This reverses a decision in `DOCMIND-DESIGN.md`.** Its Switching drivers paragraph
(line 335) reads "Changing the active driver affects new uploads only. Reads resolve the
driver from the row." That stays true for search, chat and export, and stops being true
for the library and for file reads. The design doc is updated in the same commit as this
spec.

### 1a. Every driver can say where the original is

`StorageDriver` gains one method:

```ts
describeLocation(args: { key: string }): { label: string; url?: string };
```

Synchronous, and it must never touch the network: the whole point is to answer for a
storage that is not active and may not be reachable. Settings plus the key are enough.

| Driver | label | url |
|--------|-------|-----|
| local | the absolute path on the server | none |
| s3 | `s3://bucket/prefix/key` | the provider console URL when the endpoint is known |
| googleDrive | the DocMind folder name and the filename | `https://drive.google.com/file/d/<id>/view` |

The detail page renders the label, and the url as a link when there is one, in place of
the download button. Chat citations carry the same label. That turns "your policy is on
Google Drive" into something actionable without switching storage at all.

### 2. S3-compatible driver

`drivers/s3/s3.driver.ts`, using `@aws-sdk/client-s3` with `@aws-sdk/lib-storage`.

Settings under `storage.s3.`, matching the design doc: `bucket`, `region`, `endpoint`
(blank for AWS), `accessKeyId` (secret), `secretAccessKey` (secret), `prefix` (default
`docmind/`), `forcePathStyle` (boolean, for MinIO and some clones).

`put` streams through lib-storage's `Upload`, so a large PDF never buffers in memory.
`get` returns the response `Body` stream. `delete` and `exists` map to DeleteObject and
HeadObject, with 404 becoming `false` rather than an exception.

`healthCheck` is HeadBucket, as the design doc specifies, followed by a put and delete of
a probe key. The extra probe is a deliberate addition: HeadBucket proves the bucket is
reachable, not that DocMind may write to it, and a read-only credential would otherwise
pass the check and fail on the first upload.

The guide gives the minimal IAM policy as a copyable value (GetObject, PutObject,
DeleteObject, ListBucket) and the endpoint shapes for R2, Backblaze and MinIO, since the
endpoint is the field people get wrong.

### 3. Google Drive driver

`drivers/google-drive/google-drive.driver.ts`, scope `drive.file` only so the app needs no
Google verification, files in a DocMind folder created on connect, per the design doc.

Dependency: `google-auth-library` plus direct Drive v3 REST calls, not the full
`googleapis` package. Three endpoints are needed (files create, get, delete, plus about
get); the umbrella package pulls in every Google API client for that.

Uploads use Drive's resumable protocol above five megabytes, as the design doc requires:
start an upload session, then stream the body to the session URL in chunks, so memory use
stays flat whatever the file size. Below that threshold a single multipart request is
enough.

`storage_key` holds the Drive file id, bare. An earlier draft prefixed it with `gdrive:`;
the prefix is dropped because `storage_driver` already says which driver owns the key and
nothing outside the driver reads it.

`healthCheck` calls about.get and confirms the configured folder is reachable, then
creates and trashes a probe file to prove write access.

### 4. OAuth, built the way the design doc already decided

Not Google-specific. Two routes in a new `storage.routes.ts`, parameterized by driver, so
OneDrive later adds a driver and no routes:

- `GET /api/storage/drivers/:id/connect`
- `GET /api/storage/drivers/:id/callback`

`StorageDriverDefinition` gains an optional `oauth` hook (authorize URL builder, token
exchange, the settings keys to write), which the registry already anticipates.

**State and identity.** Connect issues a state value signed with a key derived from
`SETTINGS_ENCRYPTION_KEY` via HKDF with the label `oauth-state`, expiring after ten
minutes, exactly as the design doc specifies. The signed payload carries the `userId` and
the driver id. This is also how the callback knows whose settings to write: it arrives as
a browser redirect from Google, not as an app fetch, so it cannot rely on a session
cookie. The callback verifies the signature and the expiry, rejects anything else, then
stores the refresh token as a secret and records the connected account's email.

**Redirect URI.** Derived from the request's own origin, not hardcoded, and shown on the
settings page with a copy button and a note that scheme, host and port must match exactly.
An earlier draft fixed it at `http://localhost:4000`, which was wrong twice over: port
4000 is the API, and `.claude/rules/tunnel.md` requires the browser to reach the app
through 5173, and a machine-local redirect fails outright for the remote tunnel workflow
this project is built around. Deriving it means connecting works from localhost
(`http://localhost:5173/api/storage/drivers/googleDrive/callback`, through the Vite proxy)
and from the tunnel host. The cost is that a tunnel restart changes the hostname, so a
fresh connect made over the tunnel needs its URI registered in Google Cloud first. The
guide says to prefer connecting at localhost for that reason. An established connection is
unaffected: refreshes use the stored refresh token and never touch the redirect URI.

### 5. Storage settings tab

`GET /api/storage/drivers` returns every driver's id, label, guide, whether its required
settings are filled, and how many documents it holds.

- **Browsing a driver** shows that driver's settings and guide, and nothing else. It does
  not activate anything.
- **Activating** is a separate "Switch to this storage" button. It is refused while the
  driver's health check fails, and it asks for confirmation first, naming the consequence
  in counts: "Switch to Amazon S3? 12 documents on Local filesystem will leave the library
  and 0 will appear. Search and chat keep finding all of them."
- **Test** calls `POST /api/storage/drivers/:id/test`, runs `healthCheck()` and shows the
  message it returns.
- The guide is rendered under the fields it describes: title, intro, numbered steps with
  their links and copy buttons, then the notes. Written per driver already, never displayed
  until now.

### 6. Testing

- The shared contract suite (`drivers/driver-contract.test-utils.ts`) runs against both new
  drivers, covering put, get, delete, exists and key handling. `describeLocation` joins the
  suite, so every driver present and future must answer for a key with no network call and
  while inactive.
- S3 runs against an in-process mock, Drive against a mocked token client and REST layer.
  No test makes a network call.
- Scope tests: one document on local and one on S3, active driver set each way. The list
  returns only the active storage's document; search, chat retrieval and export return
  both; each search result carries the storage holding it.
- A test that fetching the file of a document on an inactive storage fails with a message
  naming that storage, while its metadata, text and fields still resolve.
- A test that a rule rerun, a summary backfill and a re-embed all still process documents
  on an inactive storage, which is the regression the section 1 placement guards against.
- OAuth route tests: connect issues a signed state, callback rejects a tampered state, an
  expired state, and a state for a different driver.

## Out of scope

- Moving or copying files between storages: item #30, still separate. Section 1 makes its
  absence safe rather than damaging, since nothing is lost, only hidden from the list.
- OneDrive. Section 4 builds the OAuth plumbing it will reuse.
- More than one account per driver type.

## Risks

- **A switch hides documents from the library.** Intended. The mitigations are the scope
  line on the page, the confirmation naming the counts, and search and chat still finding
  everything. None of the three is optional.
- **Trash on an inactive storage.** A trashed document on an inactive storage can be
  restored but not purged, since purging deletes the file. Accepted: purge tells the user
  which storage to switch to.
- **Drive refresh token expiry.** A token for an app left in testing mode expires after
  seven days. The guide says to publish the consent screen, and an expired grant surfaces
  as a Reconnect prompt on the settings page, per the design doc's error mapping.
- **Drive rate limits.** Far tighter than S3, but storage is touched only on upload and
  delete, one file per request. Bulk jobs never touch storage.
