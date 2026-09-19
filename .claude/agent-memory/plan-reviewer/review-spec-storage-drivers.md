---
name: review-spec-storage-drivers
description: Storage drivers (S3, Google Drive) spec review, 2026-09-18 - scope claim verified false at the single-document level, OAuth loopback conflicts with tunnel workflow
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-18-storage-drivers-design.md` on 2026-09-18.
Not yet a plan; sent back for redesign. Two lessons worth carrying into the next pass
on this spec, or any future spec that scopes documents by some column.

**A "scope the list" claim must be checked against every read path, not just the list
repository method.** The spec claimed one `storageDriver` clause in
`documents.repository.ts`'s `buildViewConditions` (shared by `listByUser` and
`countByUser`) would scope the documents list, search, and chat to the active driver.
Verified in code that this is false for search/chat: `search.usecases.ts` resolves
matched chunks through `documentsRepository.findById`, a separate method with zero view
filtering (not even `deletedAt`). Same gap for the single-document GET
(`findByIdWithExtras`), `openFile`/download, and any direct-by-id route. Net effect: the
list view would hide a document but chat could still cite it, and its detail/download
route would still work, directly contradicting the spec's own stated goal ("no document
on screen whose file the app cannot reach"). Also found the reverse blast radius problem:
`buildViewConditions` is shared by more than the three surfaces the spec named. Bulk rule
rerun (`rules.usecases.ts` "all"/"category" scope queries), summary backfill, and
`reembedAll` all call `listByUser` too, so the same one-clause change would silently
narrow background maintenance jobs to the active driver's documents, an effect the spec
never discussed. General lesson: when a spec says "one filter in the shared repository
method fixes N call sites," grep every caller of that method before accepting the claim,
and grep for the specific alternate lookup methods (`findById` vs `listByUser` here) that
callers might use instead.

**OAuth loopback redirects need to be checked against this project's tunnel-based remote
testing workflow before being accepted.** See [[docmind-tunnel-testing]] equivalent in
project memory: the user tests remotely through a Cloudflare quick tunnel at port 5173,
never 4000 directly. A fixed `http://localhost:4000/...` OAuth redirect (as this spec
proposed for Google Drive) only works when the browser doing the OAuth dance is on the
same machine as the server. For a user connecting remotely through the tunnel, the
redirect sends their browser to their own local port 4000, not the server's, and the
connect flow fails silently. This will recur for OneDrive, which needs the same kind of
OAuth loopback or tunnel-hostname tradeoff. Check this explicitly any time a spec adds an
OAuth flow, and ask whether the connect step can be done through the already-tunneled
port 5173, or if a documented one-time workaround (SSH port-forward) needs to ship with
the guide.

See [[review-spec-v1]] and friends for the running list of spec review sessions on this
project.
