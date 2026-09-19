---
name: lesson-runcommand-validation-and-registry-naming
description: How to check a capability/tool registry that is called from two entry points (a model tool-call path and a direct command path), and what to name the registry file
metadata:
  type: feedback
---

Found first reviewing the assistant capability registry plan
(`docs/superpowers/plans/2026-09-19-assistant-triage.md`, 2026-09-19), see
[[review-plan-assistant-triage]].

**1. "The handler does not parse twice" is a design choice with a hidden second caller
to check.** When a registry's handler is typed to take `unknown` and is erased from a
generic `defineX<Schema>(...)` helper (mirroring `defineSetting`'s pattern in
`settings.registry.ts`), the validation has to happen exactly once, at whichever call
site invokes the handler. If a tool/capability registry is reachable from more than one
path, for example a model-chosen call that already goes through the AI layer's own
`v.safeParse(tool.schema, ...)`, and a direct, user-typed command path that never goes
near the AI layer, check that BOTH paths do the parse, or that a shared choke point does
it for both. A plan that states the no-double-parse intent for one path and is silent on
the other will produce two entry points that treat the same tool differently the moment
the schema does anything beyond a type check (trim, default, coercion, a future
constraint), quietly breaking the "one registry entry, one behavior regardless of how it
is invoked" property the registry pattern exists to guarantee.

**2. Registries are named `*.registry.ts` in this codebase, not invented per module.**
`settings.registry.ts`, `storage.registry.ts`, `extraction.registry.ts` already exist and
`.claude/rules/server-modules.md` calls this shape out by name ("Registries (AI
providers, storage drivers, settings definitions) are plain objects keyed by id"). A plan
that puts a registry of records (tools, capabilities, anything keyed by id with a
`defineX` constructor) in a file named `<module>.capabilities.ts` or similar is inventing
a new file role for a concept the codebase already has a documented, precedented name
for. Flag this even though it is purely cosmetic: the module-layout table in
`server-modules.md` is meant to be a closed set of roles.

**3. A field that happens to coincide with an existing condition at every current call
site is not automatically overengineering, if the plan itself already names the next
piece of work that needs the two to diverge.** `recordsTurn` on a capability record
duplicated `sessionId != null` at every wired call site in this plan, but the plan's own
Decision 4 already commits to plan 5 wiring the same registry to a surface (the in-app
chat) where a session always exists yet some commands still should not be recorded. Do
not reflexively call this YAGNI; check whether the plan's own later, already-scoped work
is the reason the field exists, and if so, ask instead for a test that exercises the
field's own branch independent of the condition it happens to shadow today.

**How to apply:** whenever a plan adds a registry of handlers reachable from more than
one entry point (a model tool-call path and a direct/slash-command path, or an HTTP route
and a background job), trace validation to both entry points explicitly rather than
trusting a single "the AI layer already validates this" sentence. Check registry file
naming against `settings.registry.ts` / `storage.registry.ts` / `extraction.registry.ts`
before accepting a new suffix. And when a boolean field looks redundant against a
condition, check the plan's own stated next phase before flagging it as speculative.
