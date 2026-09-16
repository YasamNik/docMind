---
name: review-plan-c1
description: Review of the Milestone C1 implementation plan (AI providers and settings page). Found module evaluation order bug, SDK call error, and provider settings lookup crash.
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-16-milestone-c1-ai-providers.md` on 2026-09-16.

**Why:** Catch SDK misuse, module wiring bugs, and spec drift before implementation.

**How to apply:** All blockers are fixed in the plan text. The implementer should follow the corrected code, not the original decisions section for Decision 6. The `.env.example` step is now a user note, not an agent action.

Key findings fixed:
- Blocker: OpenAI SDK `extra_body` for OpenRouter was spread into params object instead of passed as second arg (RequestOptions). Would put a literal `"body"` key in the JSON.
- Blocker: `getCredentials` called `settingsService.get("ai.ollama.apiKey")` for providers that don't register that setting, causing `settings.unknown_key` crash.
- Blocker: `providers/index.ts` pushed settings into `aiSettingDefinitions` as a side effect after `allSettingDefinitions` had already spread the array. Module evaluation order meant provider settings were lost. Fixed to match the `storageSettingDefinitions` pattern (import registry, flatMap).
- Major: Decision 6 said `messages.parse()` but code used `messages.create()`. Updated decision to match code.
- Major: Route tests used real HTTP requests through the adapter. Fixed with `vi.stubGlobal("fetch", ...)`.
- Major: `ai.types.ts` duplicated `SetupGuide` types from `storage.types.ts`. Fixed with re-export.
- Minor: Task 8 violated `.env.example` permission rule. Replaced with user note.
- Ruling: suggested model IDs must be verified against the live models list at manual check time.

SDK versions verified: `openai@7.17.0`, `@anthropic-ai/sdk@0.126.0`, `@valibot/to-json-schema@1.8.0`.

Related: [[review-milestone-c-spec]]
