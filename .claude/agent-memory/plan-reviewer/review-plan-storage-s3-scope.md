---
name: review-plan-storage-s3-scope
description: Storage S3-driver and scope implementation plan review, 2026-09-18 - verified prior spec fixes held, found a real cross-module wiring gap and a wrong S3 upload mock assumption
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-18-storage-s3-and-scope.md` against its spec
and against the current code on `feat/storage-drivers`. The five specific points carried
over from [[review-spec-storage-drivers]] (scope clause as an optional param outside
`buildViewConditions`, search/chat/export deliberately unscoped, the read guard living in
`openFile`/`purge` not `restore`, OAuth deferred to a second plan, `DOCMIND-DESIGN.md`
updated in the spec commit) were all genuinely fixed, not just claimed fixed. Verified
each directly in the diff and in the current tree.

Two lessons worth carrying forward, both examples of "the plan reads fine until you
check it against the actual file, not the pattern you'd expect."

**A factory that "already has X" needs grepping every call site of that factory, not
just reading its current body.** The plan's Task 5 has `storage.usecases.ts` call
`documentsRepository.countByUser(...)` inside a new usecase, as if a `documentsRepository`
were already in scope. It is not: `createStorageService({ settingsService })` takes only
`settingsService` (`storage.usecases.ts:24`), and adding `db` to that signature to build a
repository breaks two existing call sites the task's Files list never mentions:
`storage.usecases.test.ts:30` and `documents.usecases.test.ts:32`, both of which construct
`createStorageService({ settingsService })` directly. Same category of bug as the
`buildViewConditions` blast-radius finding from the spec review: a claim of "this can just
call the thing" needs grep across the codebase for who else constructs or calls that
thing, or the fix silently breaks call sites the plan never lists as touched.

**A plan's inline test snippets must be checked against the actual test file's current
harness, not the harness used elsewhere in the codebase.** Task 2/3 write tests for
`documents.usecases.test.ts` using `createTestApp()`, `t.signIn()`,
`t.services.documentsService`, and an `uploadDocument(t, userId, name)` helper. That file
does not use `createTestApp` at all today; it hand-builds `documents`/`storageService`/
`db`/`root` directly in a module-level `beforeEach`, and no file in the repo defines a
helper named `uploadDocument` (every other test module names its local upload helper
differently: `uploadWithText`, `uploadDoc`, `uploadWithChunk`). Separately, Task 5's route
tests call `t.request(...)`, which does not exist on the object `createTestApp()` returns
(only `t.app.request(...)` does, confirmed against every other `*.routes.test.ts` in the
repo), and both of Task 5's tests omit the `cookie` header from `signIn()` even though
every route in this project sits behind `sessionMiddleware` on `/api/*`. General lesson:
grep the target test file's actual current imports and fixtures before trusting a plan's
inline test snippet, even when the snippet looks like idiomatic project style; the style
can be idiomatic for a different test file than the one being edited.

**`@aws-sdk/lib-storage`'s `Upload` goes multipart for any body whose length it cannot
determine upfront, which includes every Node `Readable` stream regardless of actual
size, not only bodies above the part size.** A driver's `put(args: { body: Readable })`
being handed straight to `Upload`'s `params.Body` means every put, including a tiny test
fixture, drives the full `CreateMultipartUpload` / one-or-more `UploadPart` /
`CompleteMultipartUpload` sequence. A plan that describes the test double as "mock
`S3Client.send`, backed by an in-memory Map from key to Buffer" without naming these three
command types will produce either a mock that silently no-ops the multipart calls (put
succeeds, but bytes are never actually stored, so the very first contract test's
put-then-get round trip fails) or a lot of undocumented improvisation. Check this
explicitly any time a plan proposes mocking S3 uploads done through lib-storage's `Upload`
helper rather than a raw `PutObjectCommand`.

See [[review-spec-storage-drivers]] for the spec-level review this plan follows, and
[[review-plan-c1]] for an earlier example of a plan-level wiring gap (provider settings
lookup crash) in the same vein as the `documentsRepository` finding here.
