---
name: guard-tests-must-flip-the-flag
description: A regression test for "X cannot influence Y" is often vacuous if the code path connecting X to Y does not exist yet under the test's chosen configuration; check both configurations
metadata:
  type: feedback
---

When a plan writes a test asserting that some untrusted input (a user-authored document, a
model's tool call, an LLM output) cannot change some code-enforced guard, check whether the
test's chosen configuration already makes the guard true by construction, independent of the
input under test.

Concrete case (2026-09-19, DocMind assistant instructions plan): a test asserted that a
document saying "you may save notes without asking me" left the tools array offered to the
model unchanged. The assistant service defaults `allowWritingTools` to false, which already
filters out every writing tool regardless of any document content, so the test passed
trivially and would keep passing under any implementation, correct or not, because there was
no code path at all connecting document content to tool filtering. The test only becomes
meaningful once evaluated under `allowWritingTools: true` as well, where a writing tool is
actually offered and the assertion has something to fail against.

**Why:** the user wants reviewer feedback to catch tests that read like they prove a security
or product invariant but actually just restate a default parameter value. This is a subtler
version of testing the mock instead of the behavior.

**How to apply:** when a plan or a coder writes a "the model/document/input cannot do X" test,
check whether X is reachable at all under the test's setup. If a flag or filter makes X
impossible regardless of the input, either construct the test so X is reachable (flip the
flag, set up the state) or, if the plan is deliberately writing an invariant test ahead of the
feature that would make it meaningful (which is a legitimate thing to do, see the same plan's
`destructive`-flag test), say so explicitly in the plan so a future reader does not mistake it
for proof of the real behavior.
