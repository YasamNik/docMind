---
name: lesson-upload-then-associate-job-race
description: A spec that gates a background job on "does this document belong to record X" races the job runner whenever X is created by a follow-up API call after the document uploads
metadata:
  type: feedback
---

When a spec proposes uploading one or more documents first, then creating a parent/grouping
record afterward that points at those document ids (a receipt, a batch, an album, anything
shaped like "upload the parts, then POST the whole"), and separately proposes gating a
background job on "does this document belong to that grouping record," check the timing
before accepting the gate as workable.

**Why this matters:** `apps/server/src/modules/jobs/jobs.runner.ts` polls every
`pollIntervalMs` (default 2000ms) and claims pending jobs immediately once available. A
document's `extraction` job, and the `rules`/`summarize`/`embedding` jobs it enqueues on
completion, can easily finish before a client's next sequential HTTP call (the one that
creates the grouping record) even arrives, especially for a small image and a fast local OCR
pass. A gate written as "at extraction time, look up whether a grouping record exists for
this document's parent" will routinely find nothing, because nothing exists yet. This nearly
shipped in the family budget review (2026-09-20): the spec's stated fix, "a document with a
parent that belongs to a receipt skips summarize and rules," reads as a single condition but
is not implementable as a lookup at the point it names.

**The two real fixes, both small:**
1. Give the job a signal at upload time, before it ever runs, e.g. a value passed at
   upload that the extraction path can read off the document row itself with no join. Airtight,
   but means adding a new client-controllable input to whatever upload endpoint is shared,
   which needs its own narrow validation.
2. Do nothing to the upload/extraction path. Have the code that creates the grouping record
   (which does know every document id involved) cancel or fast-forward any jobs for the
   child documents that are still pending at that moment. Contained entirely in the new
   module, touches no shared code, but is best-effort: it will occasionally miss a job that
   already completed in the race window.

**How to apply:** whenever a plan or spec proposes a "does this document belong to X" gate
where X's row is created after the document row, ask when X's row actually exists relative
to the job runner's poll interval, not just whether the query is correct in isolation. Don't
accept "one condition" framing at face value; trace the actual sequence of HTTP calls and
background job scheduling first.
