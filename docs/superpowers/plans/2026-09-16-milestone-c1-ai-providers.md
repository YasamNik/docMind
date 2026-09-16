# Milestone C1: AI Providers and Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `ai` module with a provider registry, two adapters (OpenAI-compatible and Anthropic), a service with task slots, test connection, and model listing; plus the settings page with AI and Storage tabs.

**Architecture:** One new server module (`ai`) with provider definitions keyed by id, two adapter factories that wrap the `openai` and `@anthropic-ai/sdk` packages, and a service that resolves `provider://model` URIs through the settings module and delegates to the right adapter. The settings page is a tabbed view generated from the settings registry and the provider registry, not hand-coded per provider. No database migration in C1; all state is settings rows.

**Tech Stack:** Server adds `openai@^7.16.0`, `@anthropic-ai/sdk@^0.126.0`, `@valibot/to-json-schema@^1.8.0`. Client adds `@base-ui-components/react` Tabs (already in `@base-ui/react`). Existing shadcn components plus a new Select component added via the shadcn CLI.

**Spec:** `docs/superpowers/specs/2026-09-16-milestone-c-sorting-design.md` (sections 7, 7.5, and testing rules from section 10 that apply to C1).

## Global Constraints

- Node 22 via nvm, pnpm via corepack. Before any pnpm command in a fresh shell: `source ~/.nvm/nvm.sh && nvm use 22 && corepack enable`.
- Every HTTP input and setting is parsed with valibot before use.
- All database access through Drizzle. Raw SQL only in migrations.
- No database migration in C1. AI settings are rows in the existing settings table.
- Settings, API keys, and OAuth tokens go through the settings module only. Secrets are encrypted at rest and never logged or returned by the API.
- Error codes are asserted in tests through `expectAppError(run, code)` from `apps/server/src/shared/test/errors.test-utils.ts`.
- Module files are named by role. Tests sit next to the file as `*.test.ts`.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- `ref_code/` is reference only. Never copy from it, never import it.
- Conventional commits, subject line first, blank line, then the harness's attribution trailers on their own lines:

```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
```

- Run server tests with `pnpm --filter @docmind/server test`, client tests with `pnpm --filter @docmind/client test`.

## Decisions made in this plan

1. **Provider error sanitization regex.** Key-shaped substrings are matched by `/\b(sk-|sk-or-|sk-ant-)[a-zA-Z0-9_-]{16,}\b/g` per review ruling 12. The spec says `sk-`, `sk-or-`, and `sk-ant-` prefixes with 16+ key characters; we use `\b` word boundaries and global replace.
2. **Model cache key.** The in-memory model list cache is keyed by `${providerId}:${baseUrl}` so two providers sharing an OpenAI-compatible endpoint but with different base URLs get separate caches. Cache entries expire after 10 minutes (600,000 ms).
3. **Adapter factory shape.** Each adapter factory is a function `createXxxAdapter(config) -> AiAdapter` where config carries `apiKey`, `baseUrl`, and provider-specific flags (like `isOpenRouter`). The adapter is stateless; the OpenAI/Anthropic SDK client is created inside it.
4. **OpenRouter attribution headers.** Set via the OpenAI SDK's `defaultHeaders` constructor option: `HTTP-Referer: https://github.com/YasamNik/docMind` and `X-Title: DocMind`.
5. **OpenRouter structured output.** On structured calls, the adapter adds `require_parameters: true` to the request body via `extra_body`. In `listModels`, the adapter checks each model's `supported_parameters` array (from the OpenRouter `/models` endpoint at `https://openrouter.ai/api/v1/models`) for `"structured_output"` to set `supportsStructured`.
6. **Anthropic structured output path.** Uses `client.messages.create()` with `output_config: { format: jsonSchemaOutputFormat(...) }` from `@anthropic-ai/sdk/helpers/json-schema`. The valibot schema is converted to JSON schema via `toJsonSchema()` from `@valibot/to-json-schema`, then passed to `jsonSchemaOutputFormat()`. The response text block is JSON-parsed and validated with valibot. (`.parse()` would also work but `.create()` is simpler since we validate with valibot anyway.)
7. **Slot validation on PUT /api/settings.** When a slot key (`ai.model.rules`, `ai.model.chat`, `ai.model.embedding`) is written, the settings PUT route calls a hook registered by the AI module. The hook parses the `provider://model` value, checks that the provider's key is set (or not required), and checks the provider's capability for the slot's task. It throws `ai.slot_not_configured` or `ai.capability_missing` on failure. The hook is a `beforeSet` callback passed to `createSettingsService`.
8. **Select component.** Added via `pnpm dlx shadcn@latest add select` in `apps/client`. This installs a `select.tsx` in `components/ui/`.
9. **Tabs component.** Built as a minimal wrapper around `@base-ui/react` Tabs (already a dependency). A new file `components/ui/tabs-nav.tsx` provides `TabsNav`, `TabsNavList`, `TabsNavTab`, `TabsNavPanel` to avoid a name conflict with the existing table component. This mirrors how other UI components wrap base-ui primitives.
10. **Settings page structure.** The page loads providers from `GET /api/ai/providers` and settings from `GET /api/settings`. Provider cards and slot rows are components within the AI tab. The Storage tab renders settings whose keys start with `storage.` using the same card and guide layout as provider cards.
11. **`ai.model.embedding` is included but not wired.** The slot exists in settings and appears in the UI. The `embed` adapter method is defined but throws `ai.unsupported` in the Anthropic adapter. The embedding workflow is Phase 2; the slot is a placeholder so the UI is complete.
12. **Suggested models for OpenRouter.** Rules: `google/gemini-2.0-flash-001` (fast, structured output). Chat: `anthropic/claude-sonnet-4`. Embedding: `openai/text-embedding-3-small`.

## Interfaces inherited

- `apps/server/src/modules/settings/settings.registry.ts`: `defineSetting({ key, schema, env?, default?, secret?, doc })` returns `SettingDefinition<T>`. `createSettingsRegistry(definitions)` returns `SettingsRegistry` with `.get(key)`, `.has(key)`, `.all()`.
- `apps/server/src/modules/settings/settings.types.ts`: `SettingDefinition<T>`, `SettingSource`, `MaskedSecret`, `ResolvedSetting`.
- `apps/server/src/modules/settings/settings.usecases.ts`: `createSettingsService({ db, registry, config })` returns `SettingsService` with `.get<T>(userId, key)`, `.getResolved(userId, key)`, `.listResolved(userId)`, `.set(userId, updates)`, `.invalidate()`.
- `apps/server/src/modules/settings/settings.definitions.ts`: `allSettingDefinitions: SettingDefinition[]` array that collects all definitions.
- `apps/server/src/modules/storage/storage.settings.ts`: `storageSettingDefinitions` array, emitted from driver registry via `Object.values(storageDriverRegistry).flatMap(d => d.settings)`. Pattern to follow for AI settings.
- `apps/server/src/modules/storage/storage.types.ts`: `SetupGuideStep = { text: string; link?: string; copyValue?: string }`, `SetupGuide = { title: string; intro: string; steps: SetupGuideStep[]; notes: string[] }`.
- `apps/server/src/server.ts`: `createServer({ config, db, ocrEngine? })` returns `{ app, auth, settingsService, storageService, documentsService, jobsService, extractionService, jobRunner, ocrEngine, getUserId }`. Routes registered after `app.use("/api/*", sessionMiddleware(auth))`.
- `apps/server/src/shared/errors/errors.ts`: `createError({ code, message, status? })` returns `AppError`.
- `apps/server/src/shared/http/validate.ts`: `parseJsonBody(c, schema)`, `parseOrValidationError(schema, value)`.
- `apps/server/src/shared/test/app.test-utils.ts`: `createTestApp(opts?)` returns `{ app, db, services, config, signIn }`.
- `apps/server/src/shared/test/errors.test-utils.ts`: `expectAppError(run, code)`.
- `apps/server/src/shared/logger/logger.ts`: `createLogger(namespace)` returns pino child.
- Client `src/lib/api.ts`: `api.get<T>(path)`, `api.json<T>(method, path, body)`, `api.del(path)`, `ApiError`.
- Client `src/App.tsx`: `/settings` route currently renders a `<Placeholder>`. We replace it with the `SettingsPage`.
- Client `src/components/layout/AppShell.tsx`: sidebar links array; Settings entry already present.
- Client `src/components/ui/`: `badge`, `button`, `card` (Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction), `dialog`, `dropdown-menu`, `input`, `label`, `sonner`, `table`.

## File structure

### Server: `apps/server/src/modules/ai/`

| File | Responsibility |
|------|----------------|
| `ai.types.ts` | Type definitions: `AiAdapter`, `AiProviderDefinition`, `AiProviderCapabilities`, `ModelSlot`, `ModelInfo`, `TestResult`, `StructuredResult`, `StreamResult`, `EmbedResult` |
| `ai.models.ts` | Pure functions: `parseModelUri(uri)`, `buildModelUri(provider, model)`, `sanitizeProviderError(text)`, `MODEL_SLOTS` constant |
| `ai.settings.ts` | Setting definitions for the three model slots; collects per-provider settings from the registry |
| `ai.schemas.ts` | Valibot schemas for route inputs and the model URI format |
| `ai.usecases.ts` | `createAiService({ settingsService, registry, adapterFactories })` with `generateStructured`, `streamText`, `embed`, `listModels`, `testConnection` |
| `ai.routes.ts` | `registerAiRoutes({ app, aiService, settingsService, getUserId })` |
| `providers/openrouter.provider.ts` | OpenRouter provider definition |
| `providers/openai.provider.ts` | OpenAI provider definition |
| `providers/anthropic.provider.ts` | Anthropic provider definition |
| `providers/ollama.provider.ts` | Ollama provider definition |
| `providers/mistral.provider.ts` | Mistral provider definition |
| `providers/deepseek.provider.ts` | DeepSeek provider definition |
| `providers/lmstudio.provider.ts` | LM Studio provider definition |
| `providers/custom.provider.ts` | Custom provider definition |
| `providers/index.ts` | `aiProviderRegistry` object keyed by id in display order, `aiProviderIds` array |
| `adapters/adapter.types.ts` | `AdapterConfig` type, re-exports `AiAdapter` from types |
| `adapters/openai-compatible.adapter.ts` | `createOpenAiCompatibleAdapter(config)` |
| `adapters/anthropic.adapter.ts` | `createAnthropicAdapter(config)` |
| `__fixtures__/openrouter-models.json` | Recorded OpenRouter /models response |
| `__fixtures__/openrouter-completion.json` | Recorded structured completion response |
| `__fixtures__/openrouter-error-401.json` | Recorded 401 error response |
| `__fixtures__/anthropic-models.json` | Recorded Anthropic models list response |
| `__fixtures__/anthropic-structured.json` | Recorded Anthropic structured reply |

### Client: `apps/client/src/`

| File | Responsibility |
|------|----------------|
| `components/ui/select.tsx` | shadcn Select component (added via CLI) |
| `components/ui/tabs-nav.tsx` | Tabs component wrapping @base-ui/react Tabs |
| `lib/ai-api.ts` | API client for AI routes |
| `lib/settings-api.ts` | API client for settings routes |
| `pages/settings/SettingsPage.tsx` | Page shell with tabs (AI, Storage) |
| `pages/settings/AiTab.tsx` | AI tab: provider cards + slot rows |
| `pages/settings/ProviderCard.tsx` | One provider's key, base URL, test, and guide |
| `pages/settings/ModelSlotRow.tsx` | One slot: provider dropdown + model input |
| `pages/settings/StorageTab.tsx` | Storage settings form |

---

### Task 1: Types, models, and settings definitions

**Files:**
- Create: `apps/server/src/modules/ai/ai.types.ts`, `ai.models.ts`, `ai.schemas.ts`, `ai.settings.ts`
- Modify: `apps/server/src/modules/settings/settings.definitions.ts`
- Test: `apps/server/src/modules/ai/ai.models.test.ts`

**Interfaces:**
- Consumes: `defineSetting` from `settings.registry.ts`, `SettingDefinition` from `settings.types.ts`, `SetupGuide`, `SetupGuideStep` from `storage.types.ts` (for the guide shape).
- Produces:
  - `AiAdapter` interface with `generateStructured`, `streamText`, `embed`, `listModels`, `testConnection`.
  - `AiProviderCapabilities = { text: boolean; structured: boolean; embeddings: boolean; listModels: boolean }`.
  - `AiProviderDefinition` with `id`, `label`, `adapter` (`"openai-compatible" | "anthropic"`), `defaultBaseUrl`, `requiresKey`, `capabilities`, `suggestedModels`, `guide`, `settings`.
  - `ModelSlot = "rules" | "chat" | "embedding"`.
  - `ModelInfo = { id: string; label: string; contextLength?: number; pricing?: { prompt: number; completion: number }; supportsStructured?: boolean }`.
  - `TestResult = { ok: boolean; latencyMs: number; message: string }`.
  - `parseModelUri(uri: string): { providerId: string; model: string }` throws on bad format.
  - `buildModelUri(providerId: string, model: string): string`.
  - `sanitizeProviderError(text: string): string` replaces key-shaped substrings.
  - `MODEL_SLOTS: ModelSlot[]` = `["rules", "chat", "embedding"]`.
  - `modelSlotSchema` (valibot picklist).
  - `modelUriSchema` (valibot pipe matching `provider://model`).
  - `aiSlotSettingDefinitions`: the three slot definitions.
  - `aiSettingDefinitions`: all AI setting definitions (slots + placeholder for provider settings, filled by Task 2).

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/ai/ai.models.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildModelUri, parseModelUri, sanitizeProviderError } from "./ai.models.js";

describe("ai models", () => {
  describe("parseModelUri", () => {
    it("splits provider://model", () => {
      expect(parseModelUri("openrouter://google/gemini-2.0-flash-001")).toEqual({
        providerId: "openrouter",
        model: "google/gemini-2.0-flash-001",
      });
    });

    it("handles simple model names", () => {
      expect(parseModelUri("anthropic://claude-sonnet-4-20250514")).toEqual({
        providerId: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
    });

    it("throws on missing separator", () => {
      expect(() => parseModelUri("just-a-model")).toThrow();
    });

    it("throws on empty provider or model", () => {
      expect(() => parseModelUri("://model")).toThrow();
      expect(() => parseModelUri("provider://")).toThrow();
    });
  });

  describe("buildModelUri", () => {
    it("joins provider and model", () => {
      expect(buildModelUri("openrouter", "google/gemini-2.0-flash-001")).toBe(
        "openrouter://google/gemini-2.0-flash-001",
      );
    });
  });

  describe("sanitizeProviderError", () => {
    it("redacts sk- keys", () => {
      expect(sanitizeProviderError("Invalid key sk-1234567890abcdef1234")).toBe(
        "Invalid key [redacted]",
      );
    });

    it("redacts sk-or- keys", () => {
      expect(sanitizeProviderError("Bad: sk-or-v1-abcdefghijklmnop")).toBe("Bad: [redacted]");
    });

    it("redacts sk-ant- keys", () => {
      expect(sanitizeProviderError("Error sk-ant-api03-aaaaaabbbbbbccccccdddddd is invalid")).toBe(
        "Error [redacted] is invalid",
      );
    });

    it("leaves normal text untouched", () => {
      expect(sanitizeProviderError("Rate limit exceeded")).toBe("Rate limit exceeded");
    });

    it("handles multiple keys in one message", () => {
      const msg = "Keys sk-1234567890abcdef1234 and sk-or-v1-abcdefghijklmnop both bad";
      expect(sanitizeProviderError(msg)).toBe("Keys [redacted] and [redacted] both bad");
    });
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- ai.models`
Expected: FAIL, cannot find module `./ai.models.js`.

- [ ] **Step 3: Write the types file**

`apps/server/src/modules/ai/ai.types.ts`:
```ts
import type { GenericSchema } from "valibot";
import type { SettingDefinition } from "../settings/settings.types.js";
import type { SetupGuide, SetupGuideStep } from "../storage/storage.types.js";

export type { SetupGuide, SetupGuideStep };

export type AiProviderCapabilities = {
  text: boolean;
  structured: boolean;
  embeddings: boolean;
  listModels: boolean;
};

export type ModelSlot = "rules" | "chat" | "embedding";

export type ModelInfo = {
  id: string;
  label: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  supportsStructured?: boolean;
};

export type TestResult = {
  ok: boolean;
  latencyMs: number;
  message: string;
};

export type StructuredResult<T = unknown> = {
  data: T;
  usage: { promptTokens: number; completionTokens: number };
};

export type EmbedResult = {
  vectors: number[][];
  dimension: number;
};

export type AiAdapter = {
  generateStructured(args: {
    model: string;
    system: string;
    input: string;
    schema: GenericSchema;
    schemaName: string;
  }): Promise<StructuredResult>;
  streamText(args: {
    model: string;
    system: string;
    input: string;
  }): Promise<AsyncIterable<string>>;
  embed(args: { model: string; texts: string[] }): Promise<EmbedResult>;
  listModels(): Promise<ModelInfo[]>;
  testConnection(): Promise<TestResult>;
};

export type AiProviderDefinition = {
  id: string;
  label: string;
  adapter: "openai-compatible" | "anthropic";
  defaultBaseUrl: string;
  requiresKey: boolean;
  capabilities: AiProviderCapabilities;
  suggestedModels: { rules?: string; chat?: string; embedding?: string };
  guide: SetupGuide;
  settings: SettingDefinition[];
};
```

- [ ] **Step 4: Write the models file**

`apps/server/src/modules/ai/ai.models.ts`:
```ts
import { createError } from "../../shared/errors/errors.js";
import type { ModelSlot } from "./ai.types.js";

export const MODEL_SLOTS: ModelSlot[] = ["rules", "chat", "embedding"];

const URI_RE = /^([a-z0-9_-]+):\/\/(.+)$/;

export function parseModelUri(uri: string): { providerId: string; model: string } {
  const match = URI_RE.exec(uri);
  if (!match || !match[1] || !match[2]) {
    throw createError({
      code: "ai.invalid_model_uri",
      message: `Invalid model URI "${uri}". Expected format: provider://model`,
      status: 400,
    });
  }
  return { providerId: match[1], model: match[2] };
}

export function buildModelUri(providerId: string, model: string): string {
  return `${providerId}://${model}`;
}

const KEY_PATTERN = /\b(sk-|sk-or-|sk-ant-)[a-zA-Z0-9_-]{16,}\b/g;

export function sanitizeProviderError(text: string): string {
  return text.replace(KEY_PATTERN, "[redacted]");
}
```

- [ ] **Step 5: Write the schemas file**

`apps/server/src/modules/ai/ai.schemas.ts`:
```ts
import * as v from "valibot";
import type { ModelSlot } from "./ai.types.js";

export const modelSlotSchema = v.picklist(["rules", "chat", "embedding"] satisfies ModelSlot[]);

export const modelUriSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9_-]+:\/\/.+$/, "Expected format: provider://model"),
);

export const providerIdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9_-]+$/));

export const testProviderParamsSchema = v.object({
  id: providerIdSchema,
});

export const listModelsParamsSchema = v.object({
  id: providerIdSchema,
});
```

- [ ] **Step 6: Write the settings file (slot definitions only, provider settings added in Task 2)**

`apps/server/src/modules/ai/ai.settings.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";
import { modelUriSchema } from "./ai.schemas.js";

export const aiSlotSettingDefinitions = [
  defineSetting({
    key: "ai.model.rules",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_RULES",
    default: "",
    doc: "Model for sorting rules evaluation. Format: provider://model",
  }),
  defineSetting({
    key: "ai.model.chat",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_CHAT",
    default: "",
    doc: "Model for document chat. Format: provider://model",
  }),
  defineSetting({
    key: "ai.model.embedding",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_EMBEDDING",
    default: "",
    doc: "Model for text embeddings. Format: provider://model",
  }),
];

// Provider settings are collected here, matching the storage pattern:
// storageSettingDefinitions imports storageDriverRegistry and flatMaps its settings.
// The import from providers/index.ts is added by Task 2.
// Until Task 2, this is a placeholder that only has slot settings.
export const aiSettingDefinitions: SettingDefinition[] = [
  ...aiSlotSettingDefinitions,
];
```

- [ ] **Step 7: Wire AI settings into allSettingDefinitions**

In `apps/server/src/modules/settings/settings.definitions.ts`, add the AI settings import and spread:

Replace the entire file with:
```ts
import { extractionSettingDefinitions } from "../extraction/extraction.settings.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { aiSettingDefinitions } from "../ai/ai.settings.js";
import type { SettingDefinition } from "./settings.types.js";

export const allSettingDefinitions: SettingDefinition[] = [
  ...storageSettingDefinitions,
  ...extractionSettingDefinitions,
  ...aiSettingDefinitions,
];
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @docmind/server test -- ai.models`
Expected: PASS (3 describe blocks, all green).

- [ ] **Step 9: Run full server tests to check for regressions**

Run: `pnpm --filter @docmind/server test`
Expected: PASS. The `allSettingDefinitions` change should not break existing tests because the AI settings have defaults.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/modules/ai/ai.types.ts \
        apps/server/src/modules/ai/ai.models.ts \
        apps/server/src/modules/ai/ai.models.test.ts \
        apps/server/src/modules/ai/ai.schemas.ts \
        apps/server/src/modules/ai/ai.settings.ts \
        apps/server/src/modules/settings/settings.definitions.ts
git commit -m "$(cat <<'EOF'
feat(server): add AI module types, models, schemas, and settings definitions

Adds the foundational types for the AI module: adapter interface,
provider definition shape, model URI parsing with sanitization, and the
three model slot setting definitions (rules, chat, embedding).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 2: Provider registry with all eight definitions and guides

**Files:**
- Create: `apps/server/src/modules/ai/providers/openrouter.provider.ts`, `openai.provider.ts`, `anthropic.provider.ts`, `ollama.provider.ts`, `mistral.provider.ts`, `deepseek.provider.ts`, `lmstudio.provider.ts`, `custom.provider.ts`, `providers/index.ts`
- Modify: `apps/server/src/modules/ai/ai.settings.ts` (replace placeholder with complete list)
- Test: `apps/server/src/modules/ai/providers/providers.test.ts`

**Interfaces:**
- Consumes: `AiProviderDefinition`, `AiProviderCapabilities` from `ai.types.ts`. `defineSetting` from `settings.registry.ts`.
- Produces:
  - `aiProviderRegistry`: `Record<string, AiProviderDefinition>` with keys in display order: `openrouter`, `openai`, `anthropic`, `ollama`, `mistral`, `deepseek`, `lmstudio`, `custom`.
  - `aiProviderIds`: `string[]` in display order.
  - Each definition carries its `settings` array (apiKey + baseUrl). The complete `aiSettingDefinitions` is built in `ai.settings.ts` by importing the registry and flatMapping (same pattern as `storageSettingDefinitions`).

- [ ] **Step 1: Write the test**

`apps/server/src/modules/ai/providers/providers.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { aiProviderIds, aiProviderRegistry } from "./index.js";
import { aiSettingDefinitions } from "../ai.settings.js";

describe("ai provider registry", () => {
  it("has all eight providers in display order", () => {
    expect(aiProviderIds).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "ollama",
      "mistral",
      "deepseek",
      "lmstudio",
      "custom",
    ]);
  });

  it("every provider has the required fields", () => {
    for (const id of aiProviderIds) {
      const def = aiProviderRegistry[id]!;
      expect(def.id).toBe(id);
      expect(def.label).toBeTruthy();
      expect(["openai-compatible", "anthropic"]).toContain(def.adapter);
      expect(typeof def.defaultBaseUrl).toBe("string");
      expect(typeof def.requiresKey).toBe("boolean");
      expect(def.capabilities).toMatchObject({
        text: expect.any(Boolean),
        structured: expect.any(Boolean),
        embeddings: expect.any(Boolean),
        listModels: expect.any(Boolean),
      });
      expect(def.guide.title).toBeTruthy();
      expect(def.guide.steps.length).toBeGreaterThan(0);
    }
  });

  it("only ollama and lmstudio do not require a key", () => {
    const noKey = aiProviderIds.filter((id) => !aiProviderRegistry[id]!.requiresKey);
    expect(noKey.sort()).toEqual(["lmstudio", "ollama"]);
  });

  it("only anthropic uses the anthropic adapter", () => {
    const anthropicAdapters = aiProviderIds.filter((id) => aiProviderRegistry[id]!.adapter === "anthropic");
    expect(anthropicAdapters).toEqual(["anthropic"]);
  });

  it("emits settings for every provider into aiSettingDefinitions", () => {
    const keys = aiSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("ai.openrouter.apiKey");
    expect(keys).toContain("ai.openrouter.baseUrl");
    expect(keys).toContain("ai.anthropic.apiKey");
    expect(keys).toContain("ai.ollama.baseUrl");
    expect(keys).toContain("ai.custom.apiKey");
    expect(keys).toContain("ai.custom.baseUrl");
    expect(keys).toContain("ai.model.rules");
    expect(keys).toContain("ai.model.chat");
    expect(keys).toContain("ai.model.embedding");
  });

  it("marks apiKey settings as secret", () => {
    const apiKeys = aiSettingDefinitions.filter((d) => d.key.endsWith(".apiKey"));
    for (const def of apiKeys) {
      expect(def.secret).toBe(true);
    }
  });

  it("guide text contains no em dashes", () => {
    for (const id of aiProviderIds) {
      const def = aiProviderRegistry[id]!;
      const allText = [
        def.guide.title,
        def.guide.intro,
        ...def.guide.steps.map((s) => s.text),
        ...def.guide.notes,
      ].join(" ");
      expect(allText).not.toContain(String.fromCharCode(0x2014));
      expect(allText).not.toContain(String.fromCharCode(0x2013));
    }
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- providers`
Expected: FAIL, cannot find module `./index.js`.

- [ ] **Step 3: Write the provider definitions**

`apps/server/src/modules/ai/providers/openrouter.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const openrouterProvider: AiProviderDefinition = {
  id: "openrouter",
  label: "OpenRouter",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {
    rules: "google/gemini-2.0-flash-001",
    chat: "anthropic/claude-sonnet-4",
    embedding: "openai/text-embedding-3-small",
  },
  guide: {
    title: "Set up OpenRouter",
    intro: "OpenRouter gives you access to hundreds of models from many providers with a single API key. It is the recommended starting point for DocMind.",
    steps: [
      { text: "Go to the OpenRouter dashboard and create an account.", link: "https://openrouter.ai/settings/keys" },
      { text: "Click Create Key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: [
      "OpenRouter charges per token. Check each model's pricing on the models page.",
      "For sorting rules, pick a model that supports structured output. The suggested model is a good default.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.openrouter.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "OPENROUTER_API_KEY",
      secret: true,
      doc: "OpenRouter API key.",
    }),
    defineSetting({
      key: "ai.openrouter.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "OPENROUTER_BASE_URL",
      default: "https://openrouter.ai/api/v1",
      doc: "OpenRouter API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/openai.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const openaiProvider: AiProviderDefinition = {
  id: "openai",
  label: "OpenAI",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.openai.com/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {
    rules: "gpt-4o-mini",
    chat: "gpt-4o",
    embedding: "text-embedding-3-small",
  },
  guide: {
    title: "Set up OpenAI",
    intro: "Use OpenAI models directly. Requires an OpenAI API key with billing enabled.",
    steps: [
      { text: "Go to the OpenAI API keys page.", link: "https://platform.openai.com/api-keys" },
      { text: "Click Create new secret key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: ["OpenAI charges per token. See their pricing page for current rates."],
  },
  settings: [
    defineSetting({
      key: "ai.openai.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "OPENAI_API_KEY",
      secret: true,
      doc: "OpenAI API key.",
    }),
    defineSetting({
      key: "ai.openai.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "OPENAI_BASE_URL",
      default: "https://api.openai.com/v1",
      doc: "OpenAI API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/anthropic.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const anthropicProvider: AiProviderDefinition = {
  id: "anthropic",
  label: "Anthropic",
  adapter: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: false, listModels: true },
  suggestedModels: {
    rules: "claude-haiku-3-5-20241022",
    chat: "claude-sonnet-4-20250514",
  },
  guide: {
    title: "Set up Anthropic",
    intro: "Use Claude models directly from Anthropic. Requires an API key from the Anthropic console.",
    steps: [
      { text: "Go to the Anthropic console API keys page.", link: "https://console.anthropic.com/settings/keys" },
      { text: "Click Create Key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: [
      "Anthropic does not offer embedding models. Use OpenRouter or OpenAI for the embedding slot.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.anthropic.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "ANTHROPIC_API_KEY",
      secret: true,
      doc: "Anthropic API key.",
    }),
    defineSetting({
      key: "ai.anthropic.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "ANTHROPIC_BASE_URL",
      default: "https://api.anthropic.com",
      doc: "Anthropic API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/ollama.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const ollamaProvider: AiProviderDefinition = {
  id: "ollama",
  label: "Ollama",
  adapter: "openai-compatible",
  defaultBaseUrl: "http://localhost:11434/v1",
  requiresKey: false,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {
    rules: "llama3.1:8b",
    chat: "llama3.1:8b",
    embedding: "nomic-embed-text",
  },
  guide: {
    title: "Set up Ollama",
    intro: "Run models locally with Ollama. Free, private, no API key needed.",
    steps: [
      { text: "Install Ollama from the official site.", link: "https://ollama.ai" },
      { text: "Pull a model: ollama pull llama3.1:8b", copyValue: "ollama pull llama3.1:8b" },
      { text: "Make sure Ollama is running (it starts automatically after install), then click Test below." },
    ],
    notes: [
      "Ollama runs on your machine. The base URL defaults to localhost:11434.",
      "Structured output support varies by model. Newer models handle it better.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.ollama.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "OLLAMA_BASE_URL",
      default: "http://localhost:11434/v1",
      doc: "Ollama API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/mistral.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const mistralProvider: AiProviderDefinition = {
  id: "mistral",
  label: "Mistral",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.mistral.ai/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {
    rules: "mistral-small-latest",
    chat: "mistral-large-latest",
    embedding: "mistral-embed",
  },
  guide: {
    title: "Set up Mistral",
    intro: "Use Mistral AI models directly. Requires an API key from the Mistral console.",
    steps: [
      { text: "Go to the Mistral AI console.", link: "https://console.mistral.ai/api-keys" },
      { text: "Create an API key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: ["Mistral charges per token. Check their pricing page for current rates."],
  },
  settings: [
    defineSetting({
      key: "ai.mistral.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "MISTRAL_API_KEY",
      secret: true,
      doc: "Mistral AI API key.",
    }),
    defineSetting({
      key: "ai.mistral.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "MISTRAL_BASE_URL",
      default: "https://api.mistral.ai/v1",
      doc: "Mistral AI API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/deepseek.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const deepseekProvider: AiProviderDefinition = {
  id: "deepseek",
  label: "DeepSeek",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: false, listModels: true },
  suggestedModels: {
    rules: "deepseek-chat",
    chat: "deepseek-chat",
  },
  guide: {
    title: "Set up DeepSeek",
    intro: "Use DeepSeek models directly. Requires an API key from the DeepSeek platform.",
    steps: [
      { text: "Go to the DeepSeek platform.", link: "https://platform.deepseek.com/api_keys" },
      { text: "Create an API key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: ["DeepSeek offers competitive pricing. Check their pricing page for current rates."],
  },
  settings: [
    defineSetting({
      key: "ai.deepseek.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "DEEPSEEK_API_KEY",
      secret: true,
      doc: "DeepSeek API key.",
    }),
    defineSetting({
      key: "ai.deepseek.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "DEEPSEEK_BASE_URL",
      default: "https://api.deepseek.com/v1",
      doc: "DeepSeek API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/lmstudio.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const lmstudioProvider: AiProviderDefinition = {
  id: "lmstudio",
  label: "LM Studio",
  adapter: "openai-compatible",
  defaultBaseUrl: "http://localhost:1234/v1",
  requiresKey: false,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {},
  guide: {
    title: "Set up LM Studio",
    intro: "Run models locally with LM Studio. Free, private, no API key needed.",
    steps: [
      { text: "Download and install LM Studio.", link: "https://lmstudio.ai" },
      { text: "Download a model inside LM Studio and start the local server (Developer tab, Start Server)." },
      { text: "The default port is 1234. Click Test below to verify the connection." },
    ],
    notes: [
      "LM Studio runs on your machine. The base URL defaults to localhost:1234.",
      "Make sure the server is running before testing.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.lmstudio.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "LMSTUDIO_BASE_URL",
      default: "http://localhost:1234/v1",
      doc: "LM Studio API base URL.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/custom.provider.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const customProvider: AiProviderDefinition = {
  id: "custom",
  label: "Custom (OpenAI-compatible)",
  adapter: "openai-compatible",
  defaultBaseUrl: "",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {},
  guide: {
    title: "Set up a custom provider",
    intro: "Connect any OpenAI-compatible API. Enter the base URL and API key for your provider.",
    steps: [
      { text: "Enter the base URL of your OpenAI-compatible API below (for example, https://my-provider.example.com/v1)." },
      { text: "Enter your API key if the provider requires one." },
      { text: "Click Test to verify the connection." },
    ],
    notes: [
      "The provider must support the OpenAI chat completions API format.",
      "A base URL is required for the custom provider.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.custom.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "CUSTOM_API_KEY",
      secret: true,
      doc: "Custom provider API key.",
    }),
    defineSetting({
      key: "ai.custom.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "CUSTOM_BASE_URL",
      doc: "Custom provider API base URL. Required.",
    }),
  ],
};
```

`apps/server/src/modules/ai/providers/index.ts`:
```ts
import type { AiProviderDefinition } from "../ai.types.js";
import { openrouterProvider } from "./openrouter.provider.js";
import { openaiProvider } from "./openai.provider.js";
import { anthropicProvider } from "./anthropic.provider.js";
import { ollamaProvider } from "./ollama.provider.js";
import { mistralProvider } from "./mistral.provider.js";
import { deepseekProvider } from "./deepseek.provider.js";
import { lmstudioProvider } from "./lmstudio.provider.js";
import { customProvider } from "./custom.provider.js";

const ordered: AiProviderDefinition[] = [
  openrouterProvider,
  openaiProvider,
  anthropicProvider,
  ollamaProvider,
  mistralProvider,
  deepseekProvider,
  lmstudioProvider,
  customProvider,
];

export const aiProviderRegistry: Record<string, AiProviderDefinition> = {};
for (const def of ordered) {
  aiProviderRegistry[def.id] = def;
}

export const aiProviderIds = ordered.map((d) => d.id);
```

- [ ] **Step 4: Update `ai.settings.ts` to build the complete list from the provider registry**

Replace `apps/server/src/modules/ai/ai.settings.ts` with:
```ts
import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";
import { modelUriSchema } from "./ai.schemas.js";
import { aiProviderRegistry } from "./providers/index.js";

export const aiSlotSettingDefinitions = [
  defineSetting({
    key: "ai.model.rules",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_RULES",
    default: "",
    doc: "Model for sorting rules evaluation. Format: provider://model",
  }),
  defineSetting({
    key: "ai.model.chat",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_CHAT",
    default: "",
    doc: "Model for document chat. Format: provider://model",
  }),
  defineSetting({
    key: "ai.model.embedding",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_EMBEDDING",
    default: "",
    doc: "Model for text embeddings. Format: provider://model",
  }),
];

// Mirrors the storageSettingDefinitions pattern: import the registry and flatMap its settings.
export const aiSettingDefinitions: SettingDefinition[] = [
  ...aiSlotSettingDefinitions,
  ...Object.values(aiProviderRegistry).flatMap((d) => d.settings),
];
```

This ensures provider settings are in `aiSettingDefinitions` at the time `allSettingDefinitions` copies it via spread, because the import of `providers/index.ts` forces it to evaluate first.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @docmind/server test -- providers`
Expected: PASS.

- [ ] **Step 6: Run full server tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS. No regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/ai/providers/ \
        apps/server/src/modules/ai/ai.settings.ts
git commit -m "$(cat <<'EOF'
feat(server): add AI provider registry with eight provider definitions

Defines openrouter, openai, anthropic, ollama, mistral, deepseek,
lmstudio, and custom providers with setup guides, capabilities, and
setting definitions. Provider settings are emitted into the shared
allSettingDefinitions array.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 3: OpenAI-compatible adapter with recorded fixtures

**Files:**
- Create: `apps/server/src/modules/ai/adapters/adapter.types.ts`, `adapters/openai-compatible.adapter.ts`, `__fixtures__/openrouter-models.json`, `__fixtures__/openrouter-completion.json`, `__fixtures__/openrouter-error-401.json`
- Test: `apps/server/src/modules/ai/adapters/openai-compatible.adapter.test.ts`

**Interfaces:**
- Consumes: `AiAdapter`, `ModelInfo`, `StructuredResult`, `EmbedResult`, `TestResult` from `ai.types.ts`. `sanitizeProviderError` from `ai.models.ts`. `createError` from `shared/errors`.
- Produces: `AdapterConfig` type. `createOpenAiCompatibleAdapter(config: AdapterConfig): AiAdapter`.

- [ ] **Step 1: Write the fixture files**

`apps/server/src/modules/ai/__fixtures__/openrouter-models.json`:
```json
{
  "data": [
    {
      "id": "google/gemini-2.0-flash-001",
      "name": "Google: Gemini 2.0 Flash",
      "context_length": 1048576,
      "pricing": { "prompt": "0.0000001", "completion": "0.0000004" },
      "supported_parameters": ["temperature", "top_p", "max_tokens", "structured_output", "tools"]
    },
    {
      "id": "anthropic/claude-sonnet-4",
      "name": "Anthropic: Claude Sonnet 4",
      "context_length": 200000,
      "pricing": { "prompt": "0.000003", "completion": "0.000015" },
      "supported_parameters": ["temperature", "top_p", "max_tokens", "tools"]
    }
  ]
}
```

`apps/server/src/modules/ai/__fixtures__/openrouter-completion.json`:
```json
{
  "id": "gen-abc123",
  "object": "chat.completion",
  "created": 1726500000,
  "model": "google/gemini-2.0-flash-001",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"items\":[{\"type\":\"tag\",\"id\":\"tag_1\",\"matched\":true,\"confidence\":0.92,\"reasoning\":\"The document discusses monthly rent payments.\"}]}"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 450,
    "completion_tokens": 52,
    "total_tokens": 502
  }
}
```

`apps/server/src/modules/ai/__fixtures__/openrouter-error-401.json`:
```json
{
  "error": {
    "message": "Invalid API key provided: sk-or-v1-abcdefghijklmnopqrst. You can find your API key at https://openrouter.ai/settings/keys.",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

- [ ] **Step 2: Write the adapter types**

`apps/server/src/modules/ai/adapters/adapter.types.ts`:
```ts
export type AdapterConfig = {
  apiKey: string;
  baseUrl: string;
  providerId: string;
  isOpenRouter?: boolean;
};

export type { AiAdapter } from "../ai.types.js";
```

- [ ] **Step 3: Write the failing test**

`apps/server/src/modules/ai/adapters/openai-compatible.adapter.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createOpenAiCompatibleAdapter } from "./openai-compatible.adapter.js";
import modelsFixture from "../__fixtures__/openrouter-models.json" with { type: "json" };
import completionFixture from "../__fixtures__/openrouter-completion.json" with { type: "json" };
import errorFixture from "../__fixtures__/openrouter-error-401.json" with { type: "json" };
import * as v from "valibot";
import type { AdapterConfig } from "./adapter.types.js";

const config: AdapterConfig = {
  apiKey: "sk-or-v1-test",
  baseUrl: "https://openrouter.ai/api/v1",
  providerId: "openrouter",
  isOpenRouter: true,
};

// We mock the global fetch to intercept SDK calls
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("openai-compatible adapter", () => {
  describe("listModels", () => {
    it("returns normalized model info from the OpenRouter models endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const models = await adapter.listModels();
      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        id: "google/gemini-2.0-flash-001",
        label: "Google: Gemini 2.0 Flash",
        contextLength: 1048576,
        supportsStructured: true,
      });
      expect(models[1]).toMatchObject({
        id: "anthropic/claude-sonnet-4",
        supportsStructured: false,
      });
    });
  });

  describe("generateStructured", () => {
    it("returns parsed data and usage from a completion", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(completionFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const schema = v.object({
        items: v.array(v.object({
          type: v.picklist(["tag", "category"]),
          id: v.string(),
          matched: v.boolean(),
          confidence: v.number(),
          reasoning: v.string(),
        })),
      });
      const result = await adapter.generateStructured({
        model: "google/gemini-2.0-flash-001",
        system: "You are a sorter.",
        input: "Classify this document.",
        schema,
        schemaName: "sort_result",
      });
      expect(result.data).toMatchObject({
        items: [{ type: "tag", id: "tag_1", matched: true, confidence: 0.92 }],
      });
      expect(result.usage.promptTokens).toBe(450);
      expect(result.usage.completionTokens).toBe(52);
    });
  });

  describe("testConnection", () => {
    it("returns ok with latency on success", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toContain("2 models");
    });

    it("returns not ok with a sanitized message on 401", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(errorFixture), { status: 401, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("sk-or-v1-");
      expect(result.message).toContain("[redacted]");
    });
  });
});
```

- [ ] **Step 4: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- openai-compatible`
Expected: FAIL, cannot find module.

- [ ] **Step 5: Install the openai package and @valibot/to-json-schema**

Run:
```bash
cd apps/server && source ~/.nvm/nvm.sh && nvm use 22 && corepack enable && pnpm add openai@^7.16.0 @valibot/to-json-schema@^1.8.0
```

- [ ] **Step 6: Write the adapter**

`apps/server/src/modules/ai/adapters/openai-compatible.adapter.ts`:
```ts
// Informed by the OpenAI SDK's chat.completions.create and models.list patterns.
import OpenAI from "openai";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ModelInfo, StructuredResult, EmbedResult, TestResult } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";

function wrapError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw createError({
    code: "ai.provider_error",
    message: sanitizeProviderError(message),
    status: 502,
  });
}

export function createOpenAiCompatibleAdapter(config: AdapterConfig): AiAdapter {
  const headers: Record<string, string> = {};
  if (config.isOpenRouter) {
    headers["HTTP-Referer"] = "https://github.com/YasamNik/docMind";
    headers["X-Title"] = "DocMind";
  }

  const client = new OpenAI({
    apiKey: config.apiKey || "not-required",
    baseURL: config.baseUrl,
    defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  });

  return {
    async generateStructured({ model, system, input, schema, schemaName }): Promise<StructuredResult> {
      try {
        const jsonSchema = toJsonSchema(schema);
        // Remove the $schema key since OpenAI does not accept it
        const { $schema: _, ...cleanSchema } = jsonSchema as Record<string, unknown>;
        const response = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: input },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: schemaName,
                strict: true,
                schema: cleanSchema as Record<string, unknown>,
              },
            },
          },
          // OpenRouter: add require_parameters to the request body via SDK options
          config.isOpenRouter ? { body: { require_parameters: true } } : undefined,
        );

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw createError({
            code: "ai.provider_error",
            message: "No content in completion response",
            status: 502,
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw createError({
            code: "ai.provider_error",
            message: "Response content is not valid JSON",
            status: 502,
          });
        }

        return {
          data: parsed,
          usage: {
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
          },
        };
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as { code: string }).code.startsWith("ai.")) throw err;
        wrapError(err);
      }
    },

    async streamText({ model, system, input }): Promise<AsyncIterable<string>> {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          stream: true,
        });

        return {
          async *[Symbol.asyncIterator]() {
            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) yield delta;
            }
          },
        };
      } catch (err) {
        wrapError(err);
      }
    },

    async embed({ model, texts }): Promise<EmbedResult> {
      try {
        const response = await client.embeddings.create({
          model,
          input: texts,
        });

        const vectors = response.data.map((d) => d.embedding);
        const dimension = vectors[0]?.length ?? 0;

        return { vectors, dimension };
      } catch (err) {
        wrapError(err);
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const models: ModelInfo[] = [];
        for await (const model of client.models.list()) {
          const raw = model as unknown as Record<string, unknown>;
          const supportedParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
          models.push({
            id: model.id,
            label: (raw.name as string) ?? model.id,
            contextLength: typeof raw.context_length === "number" ? raw.context_length : undefined,
            pricing:
              raw.pricing && typeof raw.pricing === "object"
                ? {
                    prompt: Number((raw.pricing as Record<string, string>).prompt ?? 0),
                    completion: Number((raw.pricing as Record<string, string>).completion ?? 0),
                  }
                : undefined,
            supportsStructured: config.isOpenRouter
              ? supportedParams.includes("structured_output")
              : undefined,
          });
        }
        return models;
      } catch (err) {
        wrapError(err);
      }
    },

    async testConnection(): Promise<TestResult> {
      const start = Date.now();
      try {
        const models = await this.listModels();
        return {
          ok: true,
          latencyMs: Date.now() - start,
          message: `Connected. ${models.length} models available.`,
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: sanitizeProviderError(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @docmind/server test -- openai-compatible`
Expected: PASS.

- [ ] **Step 8: Run full server tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/modules/ai/adapters/adapter.types.ts \
        apps/server/src/modules/ai/adapters/openai-compatible.adapter.ts \
        apps/server/src/modules/ai/adapters/openai-compatible.adapter.test.ts \
        apps/server/src/modules/ai/__fixtures__/ \
        apps/server/package.json \
        pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(server): add OpenAI-compatible adapter with recorded fixtures

Implements the adapter wrapping the openai SDK for chat completions
with structured output (json_schema response_format), streaming,
embeddings, model listing, and test connection. Includes OpenRouter
attribution headers and structured_output capability detection.
Tests run against recorded JSON fixtures, never the network.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 4: Anthropic adapter with recorded fixtures

**Files:**
- Create: `apps/server/src/modules/ai/adapters/anthropic.adapter.ts`, `__fixtures__/anthropic-models.json`, `__fixtures__/anthropic-structured.json`
- Test: `apps/server/src/modules/ai/adapters/anthropic.adapter.test.ts`

**Interfaces:**
- Consumes: `AiAdapter`, `ModelInfo`, `StructuredResult`, `TestResult` from `ai.types.ts`. `sanitizeProviderError` from `ai.models.ts`. `createError` from `shared/errors`. `AdapterConfig` from `adapter.types.ts`.
- Produces: `createAnthropicAdapter(config: AdapterConfig): AiAdapter`.

- [ ] **Step 1: Write the fixture files**

`apps/server/src/modules/ai/__fixtures__/anthropic-models.json`:
```json
{
  "data": [
    {
      "id": "claude-sonnet-4-20250514",
      "display_name": "Claude Sonnet 4",
      "created_at": "2025-05-14T00:00:00Z",
      "type": "model",
      "max_input_tokens": 200000,
      "max_tokens": 8192,
      "capabilities": null
    },
    {
      "id": "claude-haiku-3-5-20241022",
      "display_name": "Claude 3.5 Haiku",
      "created_at": "2024-10-22T00:00:00Z",
      "type": "model",
      "max_input_tokens": 200000,
      "max_tokens": 8192,
      "capabilities": null
    }
  ],
  "has_more": false,
  "first_id": "claude-sonnet-4-20250514",
  "last_id": "claude-haiku-3-5-20241022"
}
```

`apps/server/src/modules/ai/__fixtures__/anthropic-structured.json`:
```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "{\"items\":[{\"type\":\"category\",\"id\":\"cat_1\",\"matched\":true,\"confidence\":0.88,\"reasoning\":\"This is a financial document related to taxes.\"}]}"
    }
  ],
  "model": "claude-sonnet-4-20250514",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 380,
    "output_tokens": 65
  }
}
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/modules/ai/adapters/anthropic.adapter.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAnthropicAdapter } from "./anthropic.adapter.js";
import modelsFixture from "../__fixtures__/anthropic-models.json" with { type: "json" };
import structuredFixture from "../__fixtures__/anthropic-structured.json" with { type: "json" };
import * as v from "valibot";
import type { AdapterConfig } from "./adapter.types.js";

const config: AdapterConfig = {
  apiKey: "sk-ant-test-key-1234567890",
  baseUrl: "https://api.anthropic.com",
  providerId: "anthropic",
};

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("anthropic adapter", () => {
  describe("listModels", () => {
    it("returns normalized model info from the Anthropic models endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const models = await adapter.listModels();
      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        id: "claude-sonnet-4-20250514",
        label: "Claude Sonnet 4",
        contextLength: 200000,
      });
    });
  });

  describe("generateStructured", () => {
    it("returns parsed data and usage", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(structuredFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const schema = v.object({
        items: v.array(v.object({
          type: v.picklist(["tag", "category"]),
          id: v.string(),
          matched: v.boolean(),
          confidence: v.number(),
          reasoning: v.string(),
        })),
      });
      const result = await adapter.generateStructured({
        model: "claude-sonnet-4-20250514",
        system: "You are a sorter.",
        input: "Classify this document.",
        schema,
        schemaName: "sort_result",
      });
      expect(result.data).toMatchObject({
        items: [{ type: "category", id: "cat_1", matched: true, confidence: 0.88 }],
      });
      expect(result.usage.promptTokens).toBe(380);
      expect(result.usage.completionTokens).toBe(65);
    });
  });

  describe("embed", () => {
    it("throws ai.unsupported", async () => {
      const adapter = createAnthropicAdapter(config);
      await expect(adapter.embed({ model: "any", texts: ["hello"] })).rejects.toMatchObject({ code: "ai.unsupported" });
    });
  });

  describe("testConnection", () => {
    it("returns ok with latency on success", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toContain("2 models");
    });
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- anthropic.adapter`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Install the Anthropic SDK**

Run:
```bash
cd apps/server && source ~/.nvm/nvm.sh && nvm use 22 && corepack enable && pnpm add @anthropic-ai/sdk@^0.126.0
```

- [ ] **Step 5: Write the adapter**

`apps/server/src/modules/ai/adapters/anthropic.adapter.ts`:
```ts
// Informed by the Anthropic SDK's messages.parse and jsonSchemaOutputFormat patterns.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ModelInfo, StructuredResult, EmbedResult, TestResult } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";

function wrapError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw createError({
    code: "ai.provider_error",
    message: sanitizeProviderError(message),
    status: 502,
  });
}

export function createAnthropicAdapter(config: AdapterConfig): AiAdapter {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });

  return {
    async generateStructured({ model, system, input, schema, schemaName }): Promise<StructuredResult> {
      try {
        const jsonSchema = toJsonSchema(schema);
        const { $schema: _, ...cleanSchema } = jsonSchema as Record<string, unknown>;

        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: input }],
          output_config: {
            format: jsonSchemaOutputFormat({
              ...cleanSchema,
              type: "object" as const,
            } as Parameters<typeof jsonSchemaOutputFormat>[0]),
          },
        });

        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw createError({
            code: "ai.provider_error",
            message: "No text content in Anthropic response",
            status: 502,
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(textBlock.text);
        } catch {
          throw createError({
            code: "ai.provider_error",
            message: "Response content is not valid JSON",
            status: 502,
          });
        }

        return {
          data: parsed,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as { code: string }).code.startsWith("ai.")) throw err;
        wrapError(err);
      }
    },

    async streamText({ model, system, input }): Promise<AsyncIterable<string>> {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: input }],
        });

        return {
          async *[Symbol.asyncIterator]() {
            for await (const event of stream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                yield event.delta.text;
              }
            }
          },
        };
      } catch (err) {
        wrapError(err);
      }
    },

    async embed(): Promise<EmbedResult> {
      throw createError({
        code: "ai.unsupported",
        message: "Anthropic does not support embeddings. Use OpenRouter or OpenAI for the embedding slot.",
        status: 400,
      });
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const models: ModelInfo[] = [];
        for await (const model of client.models.list()) {
          models.push({
            id: model.id,
            label: model.display_name,
            contextLength: model.max_input_tokens ?? undefined,
          });
        }
        return models;
      } catch (err) {
        wrapError(err);
      }
    },

    async testConnection(): Promise<TestResult> {
      const start = Date.now();
      try {
        const models = await this.listModels();
        return {
          ok: true,
          latencyMs: Date.now() - start,
          message: `Connected. ${models.length} models available.`,
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: sanitizeProviderError(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @docmind/server test -- anthropic.adapter`
Expected: PASS.

- [ ] **Step 7: Run full server tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/ai/adapters/anthropic.adapter.ts \
        apps/server/src/modules/ai/adapters/anthropic.adapter.test.ts \
        apps/server/src/modules/ai/__fixtures__/anthropic-models.json \
        apps/server/src/modules/ai/__fixtures__/anthropic-structured.json \
        apps/server/package.json \
        pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(server): add Anthropic adapter with recorded fixtures

Implements the adapter wrapping the @anthropic-ai/sdk for structured
output via messages.create with jsonSchemaOutputFormat, streaming text,
and model listing. Embeddings throw ai.unsupported. Tests run against
recorded JSON fixtures.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 5: AI service with a fake adapter

**Files:**
- Create: `apps/server/src/modules/ai/ai.usecases.ts`
- Test: `apps/server/src/modules/ai/ai.usecases.test.ts`

**Interfaces:**
- Consumes: `AiAdapter`, `AiProviderDefinition`, `ModelSlot`, `ModelInfo`, `StructuredResult`, `TestResult` from `ai.types.ts`. `parseModelUri` from `ai.models.ts`. `SettingsService` from `settings.usecases.ts`. `aiProviderRegistry` from `providers/index.ts`. `createError` from `shared/errors`. `createLogger` from `shared/logger`.
- Produces: `createAiService({ settingsService, registry, adapterFactories })` returning `AiService` with:
  - `generateStructured<T>({ userId, task, schema, schemaName, system, input }): Promise<StructuredResult<T>>`
  - `streamText({ userId, task, system, input }): Promise<AsyncIterable<string>>`
  - `embed({ userId, task, texts }): Promise<EmbedResult>`
  - `listModels(userId: string, providerId: string): Promise<{ models: ModelInfo[]; error?: string }>`
  - `testConnection(userId: string, providerId: string): Promise<TestResult>`
  - `resolveSlot(userId: string, task: ModelSlot): Promise<{ providerId: string; model: string; provider: AiProviderDefinition }>`

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/ai/ai.usecases.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry, defineSetting } from "../settings/settings.registry.js";
import { createSettingsService, type SettingsService } from "../settings/settings.usecases.js";
import { createAiService } from "./ai.usecases.js";
import { aiSettingDefinitions } from "./ai.settings.js";
import { aiProviderRegistry } from "./providers/index.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "./ai.types.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";

function fakeAdapter(overrides: Partial<AiAdapter> = {}): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      data: { items: [{ type: "tag", id: "t1", matched: true, confidence: 0.9, reasoning: "test" }] },
      usage: { promptTokens: 100, completionTokens: 20 },
    })),
    streamText: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() { yield "hello"; },
    })),
    embed: vi.fn(async () => ({ vectors: [[0.1, 0.2]], dimension: 2 })),
    listModels: vi.fn(async () => [
      { id: "test-model", label: "Test Model", contextLength: 8000 },
    ] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 42, message: "Connected. 1 models available." }) as TestResult),
    ...overrides,
  };
}

async function setup(env: Record<string, string> = {}) {
  const { db } = await createTestDatabase();
  const registry = createSettingsRegistry(aiSettingDefinitions);
  const settingsService = createSettingsService({
    db,
    registry,
    config: { settingsEncryptionKey: "ab".repeat(32), env },
  });
  const adapter = fakeAdapter();
  const adapterFactories = {
    "openai-compatible": vi.fn(() => adapter),
    "anthropic": vi.fn(() => adapter),
  };
  const aiService = createAiService({
    settingsService,
    registry: aiProviderRegistry,
    adapterFactories,
  });
  return { settingsService, aiService, adapter, adapterFactories };
}

const userId = "user-1";

describe("ai service", () => {
  it("resolves a slot from settings and calls the adapter", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.rules": "openrouter://google/gemini-2.0-flash-001",
    });
    const schema = v.object({ items: v.array(v.unknown()) });
    const result = await aiService.generateStructured({
      userId,
      task: "rules",
      schema,
      schemaName: "test",
      system: "test",
      input: "test",
    });
    expect(result.data).toBeTruthy();
    expect(adapter.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "google/gemini-2.0-flash-001" }),
    );
  });

  it("uses suggested model when slot is empty but provider key is set", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test" });
    // No slot set, but OpenRouter has a suggestedModels.rules
    const schema = v.object({ items: v.array(v.unknown()) });
    const result = await aiService.generateStructured({
      userId,
      task: "rules",
      schema,
      schemaName: "test",
      system: "test",
      input: "test",
    });
    expect(result.data).toBeTruthy();
    expect(adapter.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "google/gemini-2.0-flash-001" }),
    );
  });

  it("throws ai.slot_not_configured when no slot and no key", async () => {
    const { aiService } = await setup();
    const schema = v.object({ items: v.array(v.unknown()) });
    await expectAppError(
      () => aiService.generateStructured({ userId, task: "rules", schema, schemaName: "test", system: "test", input: "test" }),
      "ai.slot_not_configured",
    );
  });

  it("throws ai.provider_not_configured when slot set but key missing", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, { "ai.model.rules": "openrouter://some-model" });
    const schema = v.object({ items: v.array(v.unknown()) });
    await expectAppError(
      () => aiService.generateStructured({ userId, task: "rules", schema, schemaName: "test", system: "test", input: "test" }),
      "ai.provider_not_configured",
    );
  });

  it("lists models with cache", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test" });
    const r1 = await aiService.listModels(userId, "openrouter");
    const r2 = await aiService.listModels(userId, "openrouter");
    expect(r1.models).toHaveLength(1);
    expect(r2.models).toHaveLength(1);
    // Adapter should be called only once due to cache
    expect(adapter.listModels).toHaveBeenCalledTimes(1);
  });

  it("tests connection for a provider", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test" });
    const result = await aiService.testConnection(userId, "openrouter");
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("validates the structured response with valibot", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.rules": "openrouter://test",
    });
    // Use a strict schema that the fake adapter's response does not match
    const schema = v.object({ wrongField: v.string() });
    await expectAppError(
      () => aiService.generateStructured({ userId, task: "rules", schema, schemaName: "test", system: "test", input: "test" }),
      "ai.invalid_response",
    );
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- ai.usecases`
Expected: FAIL, cannot find module `./ai.usecases.js`.

- [ ] **Step 3: Write the service**

`apps/server/src/modules/ai/ai.usecases.ts`:
```ts
import * as v from "valibot";
import type { GenericSchema } from "valibot";
import { createError } from "../../shared/errors/errors.js";
import { createLogger } from "../../shared/logger/logger.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { parseModelUri, buildModelUri, MODEL_SLOTS } from "./ai.models.js";
import type {
  AiAdapter,
  AiProviderDefinition,
  EmbedResult,
  ModelInfo,
  ModelSlot,
  StructuredResult,
  TestResult,
} from "./ai.types.js";
import type { AdapterConfig } from "./adapters/adapter.types.js";

const logger = createLogger("ai");
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CacheEntry = { models: ModelInfo[]; fetchedAt: number };
type AdapterFactories = {
  "openai-compatible": (config: AdapterConfig) => AiAdapter;
  "anthropic": (config: AdapterConfig) => AiAdapter;
};

export function createAiService({
  settingsService,
  registry,
  adapterFactories,
}: {
  settingsService: SettingsService;
  registry: Record<string, AiProviderDefinition>;
  adapterFactories: AdapterFactories;
}) {
  const modelCache = new Map<string, CacheEntry>();

  async function getCredentials(userId: string, providerId: string) {
    const provider = registry[providerId];
    if (!provider) {
      throw createError({
        code: "ai.unknown_provider",
        message: `Unknown AI provider "${providerId}"`,
        status: 400,
      });
    }
    // Only query settings that this provider actually registers.
    // Ollama and LM Studio have no apiKey setting; querying it would throw settings.unknown_key.
    const hasApiKey = provider.settings.some((s) => s.key.endsWith(".apiKey"));
    const hasBaseUrl = provider.settings.some((s) => s.key.endsWith(".baseUrl"));
    const apiKey = hasApiKey ? (await settingsService.get<string>(userId, `ai.${providerId}.apiKey`)) ?? "" : "";
    const baseUrl = hasBaseUrl ? (await settingsService.get<string>(userId, `ai.${providerId}.baseUrl`)) ?? provider.defaultBaseUrl : provider.defaultBaseUrl;
    return { provider, apiKey, baseUrl };
  }

  function buildAdapter(provider: AiProviderDefinition, apiKey: string, baseUrl: string): AiAdapter {
    const config: AdapterConfig = {
      apiKey,
      baseUrl,
      providerId: provider.id,
      isOpenRouter: provider.id === "openrouter",
    };
    return adapterFactories[provider.adapter](config);
  }

  async function resolveSlot(userId: string, task: ModelSlot) {
    const slotValue = await settingsService.get<string>(userId, `ai.model.${task}`);

    if (slotValue) {
      const { providerId, model } = parseModelUri(slotValue);
      const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
      if (provider.requiresKey && !apiKey) {
        throw createError({
          code: "ai.provider_not_configured",
          message: `Provider "${provider.label}" requires an API key. Set it on the Settings page.`,
          status: 400,
        });
      }
      return { providerId, model, provider, apiKey, baseUrl };
    }

    // No slot set: find the first provider with a key set and a suggested model
    for (const id of Object.keys(registry)) {
      const def = registry[id]!;
      const suggested = def.suggestedModels[task];
      if (!suggested) continue;

      if (def.requiresKey) {
        const key = await settingsService.get<string>(userId, `ai.${id}.apiKey`);
        if (!key) continue;
        const base = await settingsService.get<string>(userId, `ai.${id}.baseUrl`) ?? def.defaultBaseUrl;
        return { providerId: id, model: suggested, provider: def, apiKey: key, baseUrl: base };
      }
      // Provider does not require a key (Ollama, LM Studio)
      const base = await settingsService.get<string>(userId, `ai.${id}.baseUrl`) ?? def.defaultBaseUrl;
      return { providerId: id, model: suggested, provider: def, apiKey: "", baseUrl: base };
    }

    throw createError({
      code: "ai.slot_not_configured",
      message: `No model configured for the "${task}" task. Set a provider key and pick a model on the Settings page.`,
      status: 400,
    });
  }

  return {
    resolveSlot,

    async generateStructured<T>({
      userId,
      task,
      schema,
      schemaName,
      system,
      input,
    }: {
      userId: string;
      task: ModelSlot;
      schema: GenericSchema;
      schemaName: string;
      system: string;
      input: string;
    }): Promise<StructuredResult<T>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, task);
      if (!provider.capabilities.structured) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support structured output.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.generateStructured({ model, system, input, schema, schemaName });
      const latency = Date.now() - start;
      logger.info({ task, model: buildModelUri(provider.id, model), latency, usage: result.usage }, "structured generation complete");

      // Validate the response with the valibot schema
      const parsed = v.safeParse(schema, result.data);
      if (!parsed.success) {
        const firstIssue = parsed.issues[0];
        const path = firstIssue?.path?.map((p) => String(p.key)).join(".") ?? "";
        throw createError({
          code: "ai.invalid_response",
          message: `Model response does not match schema${path ? ` at ${path}` : ""}: ${firstIssue?.message ?? "invalid"}`,
          status: 502,
        });
      }

      return { data: parsed.output as T, usage: result.usage };
    },

    async streamText({
      userId,
      task,
      system,
      input,
    }: {
      userId: string;
      task: ModelSlot;
      system: string;
      input: string;
    }): Promise<AsyncIterable<string>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, task);
      if (!provider.capabilities.text) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support text generation.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      return adapter.streamText({ model, system, input });
    },

    async embed({
      userId,
      task,
      texts,
    }: {
      userId: string;
      task: ModelSlot;
      texts: string[];
    }): Promise<EmbedResult> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, task);
      if (!provider.capabilities.embeddings) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support embeddings.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      return adapter.embed({ model, texts });
    },

    async listModels(userId: string, providerId: string): Promise<{ models: ModelInfo[]; error?: string }> {
      const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
      const cacheKey = `${providerId}:${baseUrl}`;
      const cached = modelCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return { models: cached.models };
      }
      try {
        const adapter = buildAdapter(provider, apiKey, baseUrl);
        const models = await adapter.listModels();
        modelCache.set(cacheKey, { models, fetchedAt: Date.now() });
        return { models };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { models: [], error: message };
      }
    },

    async testConnection(userId: string, providerId: string): Promise<TestResult> {
      const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      return adapter.testConnection();
    },
  };
}

export type AiService = ReturnType<typeof createAiService>;
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @docmind/server test -- ai.usecases`
Expected: PASS.

- [ ] **Step 5: Run full server tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/ai/ai.usecases.ts \
        apps/server/src/modules/ai/ai.usecases.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add AI service with slot resolution, caching, and validation

Implements createAiService with generateStructured (validates response
against valibot schema), streamText, embed, listModels (cached 10 min
per provider+baseUrl), testConnection, and resolveSlot (explicit slot,
then first provider with a key and a suggested model). Tests use a fake
adapter, never the network.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 6: Routes, slot validation hook, wiring in server.ts

**Files:**
- Create: `apps/server/src/modules/ai/ai.routes.ts`
- Modify: `apps/server/src/server.ts`, `apps/server/src/modules/settings/settings.usecases.ts`, `apps/server/src/shared/test/app.test-utils.ts`
- Test: `apps/server/src/modules/ai/ai.routes.test.ts`

**Interfaces:**
- Consumes: `AiService` from `ai.usecases.ts`. `SettingsService` from `settings.usecases.ts`. `parseOrValidationError` from `validate.ts`. `providerIdSchema` from `ai.schemas.ts`. `createError` from `shared/errors`. `getUserId` function.
- Produces:
  - `registerAiRoutes({ app, aiService, settingsService, getUserId })`.
  - `GET /api/ai/providers` -> `{ providers: [...], slots: { rules: { value, source, suggestion }, chat: {...}, embedding: {...} } }`.
  - `POST /api/ai/providers/:id/test` -> `{ ok, latencyMs, message }`.
  - `GET /api/ai/providers/:id/models` -> `{ models: ModelInfo[], error?: string }`.
  - `settingsService` gains a `beforeSet` hook so the AI module can validate slot writes.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/ai/ai.routes.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

// Stub fetch so adapter calls never hit the network.
const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  // Default: return a minimal models response so testConnection works
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: "test-model", name: "Test" }] }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", mockFetch);
});

describe("ai routes", () => {
  it("GET /api/ai/providers returns providers and slots", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/ai/providers", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toBeInstanceOf(Array);
    expect(body.providers.length).toBe(8);
    expect(body.providers[0].id).toBe("openrouter");
    expect(body.providers[0].guide).toBeTruthy();
    expect(body.providers[0]).toHaveProperty("keySet");
    expect(body.slots).toMatchObject({
      rules: expect.objectContaining({ value: "", source: expect.any(String) }),
      chat: expect.objectContaining({ value: "", source: expect.any(String) }),
      embedding: expect.objectContaining({ value: "", source: expect.any(String) }),
    });
  });

  it("GET /api/ai/providers requires auth", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/ai/providers");
    expect(res.status).toBe(401);
  });

  it("POST /api/ai/providers/:id/test tests a provider", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    // Set a key so test can build an adapter (the fake adapter will be used)
    await services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-testkey1234" });
    const res = await app.request("/api/ai/providers/openrouter/test", {
      method: "POST",
      headers: { cookie },
    });
    // The response depends on whether the fake adapter succeeds or the real
    // adapter fails against a fake key. Since testConnection catches errors,
    // we just check the shape.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("latencyMs");
    expect(body).toHaveProperty("message");
  });

  it("GET /api/ai/providers/:id/models returns a model list or error", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/ai/providers/openrouter/models", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("models");
    expect(body.models).toBeInstanceOf(Array);
  });

  it("rejects unknown provider id", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/ai/providers/nope/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("PUT /api/settings validates a slot write for missing key", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { "ai.model.rules": "openrouter://some-model" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("ai.provider_not_configured");
  });

  it("PUT /api/settings accepts a slot when the key is set", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    await services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-testkey1234" });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { "ai.model.rules": "openrouter://google/gemini-2.0-flash-001" } }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT /api/settings allows clearing a slot with empty string", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    await services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-testkey1234" });
    await services.settingsService.set(userId, { "ai.model.rules": "openrouter://some-model" });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { "ai.model.rules": "" } }),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- ai.routes`
Expected: FAIL, missing routes.

- [ ] **Step 3: Add a `beforeSet` hook to the settings service**

In `apps/server/src/modules/settings/settings.usecases.ts`, modify `ServiceConfig` and the `set` method to support a `beforeSet` callback:

Add to `ServiceConfig`:
```ts
type ServiceConfig = {
  settingsEncryptionKey: string;
  env: Record<string, string | undefined>;
  beforeSet?: (userId: string, updates: Record<string, unknown>) => Promise<void>;
};
```

In the `set` method, add a call to `config.beforeSet` before the validation loop:

After `const writes: Array<...> = [];` and before the `for (const [key, value] of Object.entries(updates))` loop, add:
```ts
if (config.beforeSet) {
  await config.beforeSet(userId, updates);
}
```

- [ ] **Step 4: Write the routes**

`apps/server/src/modules/ai/ai.routes.ts`:
```ts
import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { providerIdSchema } from "./ai.schemas.js";
import { MODEL_SLOTS } from "./ai.models.js";
import { aiProviderRegistry, aiProviderIds } from "./providers/index.js";
import type { AiService } from "./ai.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { createError } from "../../shared/errors/errors.js";

export function registerAiRoutes({
  app,
  aiService,
  settingsService,
  getUserId,
}: {
  app: Hono;
  aiService: AiService;
  settingsService: SettingsService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/ai/providers", async (c) => {
    const userId = getUserId(c);

    const providers = await Promise.all(
      aiProviderIds.map(async (id) => {
        const def = aiProviderRegistry[id]!;
        const keyResolved = def.settings.find((s) => s.key.endsWith(".apiKey"))
          ? await settingsService.getResolved(userId, `ai.${id}.apiKey`)
          : null;
        const baseUrlResolved = await settingsService.getResolved(userId, `ai.${id}.baseUrl`).catch(() => null);

        return {
          id: def.id,
          label: def.label,
          adapter: def.adapter,
          defaultBaseUrl: def.defaultBaseUrl,
          requiresKey: def.requiresKey,
          capabilities: def.capabilities,
          suggestedModels: def.suggestedModels,
          guide: def.guide,
          keySet: keyResolved ? (keyResolved.value as { isSet: boolean }).isSet : false,
          keyLastFour: keyResolved ? (keyResolved.value as { lastFour?: string }).lastFour : undefined,
          baseUrl: baseUrlResolved
            ? { value: baseUrlResolved.value as string, source: baseUrlResolved.source }
            : { value: def.defaultBaseUrl, source: "default" as const },
        };
      }),
    );

    const slots: Record<string, unknown> = {};
    for (const slot of MODEL_SLOTS) {
      const resolved = await settingsService.getResolved(userId, `ai.model.${slot}`);
      // Find the suggestion for this slot from the first configured provider
      let suggestion: string | undefined;
      for (const id of aiProviderIds) {
        const def = aiProviderRegistry[id]!;
        const suggested = def.suggestedModels[slot];
        if (!suggested) continue;
        if (!def.requiresKey) {
          suggestion = `${id}://${suggested}`;
          break;
        }
        const keyRes = await settingsService.getResolved(userId, `ai.${id}.apiKey`);
        if ((keyRes.value as { isSet: boolean }).isSet) {
          suggestion = `${id}://${suggested}`;
          break;
        }
      }
      slots[slot] = { value: resolved.value, source: resolved.source, suggestion };
    }

    return c.json({ providers, slots });
  });

  app.post("/api/ai/providers/:id/test", async (c) => {
    const id = parseOrValidationError(providerIdSchema, c.req.param("id"));
    if (!aiProviderRegistry[id]) {
      throw createError({ code: "ai.unknown_provider", message: `Unknown provider "${id}"`, status: 400 });
    }
    const userId = getUserId(c);
    const result = await aiService.testConnection(userId, id);
    return c.json(result);
  });

  app.get("/api/ai/providers/:id/models", async (c) => {
    const id = parseOrValidationError(providerIdSchema, c.req.param("id"));
    if (!aiProviderRegistry[id]) {
      throw createError({ code: "ai.unknown_provider", message: `Unknown provider "${id}"`, status: 400 });
    }
    const userId = getUserId(c);
    const result = await aiService.listModels(userId, id);
    return c.json(result);
  });
}
```

- [ ] **Step 5: Wire the AI module in server.ts**

In `apps/server/src/server.ts`, add imports:
```ts
import { registerAiRoutes } from "./modules/ai/ai.routes.js";
import { createAiService } from "./modules/ai/ai.usecases.js";
import { aiProviderRegistry } from "./modules/ai/providers/index.js";
import { createOpenAiCompatibleAdapter } from "./modules/ai/adapters/openai-compatible.adapter.js";
import { createAnthropicAdapter } from "./modules/ai/adapters/anthropic.adapter.js";
import { parseModelUri } from "./modules/ai/ai.models.js";
```

After `const settingsService = createSettingsService(...)`, create the AI service:
```ts
const adapterFactories = {
  "openai-compatible": createOpenAiCompatibleAdapter,
  "anthropic": createAnthropicAdapter,
};
const aiService = createAiService({ settingsService, registry: aiProviderRegistry, adapterFactories });
```

Add a `beforeSet` callback to the settings service config that validates slot writes:
```ts
const settingsService = createSettingsService({
  db,
  registry: createSettingsRegistry(allSettingDefinitions),
  config: {
    settingsEncryptionKey: config.settingsEncryptionKey,
    env: config.env,
    beforeSet: async (userId, updates) => {
      for (const [key, value] of Object.entries(updates)) {
        if (key.startsWith("ai.model.") && typeof value === "string" && value !== "" && value !== null) {
          const { providerId } = parseModelUri(value);
          const provider = aiProviderRegistry[providerId];
          if (!provider) {
            throw createError({ code: "ai.unknown_provider", message: `Unknown provider "${providerId}"`, status: 400 });
          }
          if (provider.requiresKey) {
            const apiKey = await settingsService.get<string>(userId, `ai.${providerId}.apiKey`);
            if (!apiKey) {
              throw createError({
                code: "ai.provider_not_configured",
                message: `Provider "${provider.label}" requires an API key. Set it first.`,
                status: 400,
              });
            }
          }
          // Check capability for the slot's task
          const slot = key.replace("ai.model.", "");
          if (slot === "embedding" && !provider.capabilities.embeddings) {
            throw createError({
              code: "ai.capability_missing",
              message: `Provider "${provider.label}" does not support embeddings.`,
              status: 400,
            });
          }
          if ((slot === "rules") && !provider.capabilities.structured) {
            throw createError({
              code: "ai.capability_missing",
              message: `Provider "${provider.label}" does not support structured output, which is required for the rules slot.`,
              status: 400,
            });
          }
        }
      }
    },
  },
});
```

Note: The `settingsService` is created before `aiService`, and the `beforeSet` hook uses `settingsService` itself to check the key. This works because `beforeSet` is async and called at runtime after creation, not during it.

Register the routes after the other routes:
```ts
registerAiRoutes({ app, aiService, settingsService, getUserId });
```

Add `aiService` to the returned object:
```ts
return { app, auth, settingsService, storageService, documentsService, jobsService, extractionService, jobRunner, ocrEngine, aiService, getUserId };
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @docmind/server test -- ai.routes`
Expected: PASS.

- [ ] **Step 7: Run full server tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS. The `beforeSet` hook must not break existing settings tests because those tests use keys that do not start with `ai.model.`.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/ai/ai.routes.ts \
        apps/server/src/modules/ai/ai.routes.test.ts \
        apps/server/src/modules/settings/settings.usecases.ts \
        apps/server/src/server.ts \
        apps/server/src/shared/test/app.test-utils.ts
git commit -m "$(cat <<'EOF'
feat(server): add AI routes, slot validation hook, and server wiring

Adds GET /api/ai/providers (registry + slots), POST providers/:id/test,
GET providers/:id/models. The settings PUT route now validates slot
writes through a beforeSet hook that checks provider credentials and
capabilities. AI service and adapters are wired in server.ts.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 7: Client settings page with AI and Storage tabs

**Files:**
- Create: `apps/client/src/components/ui/tabs-nav.tsx`, `apps/client/src/components/ui/select.tsx` (via shadcn CLI), `apps/client/src/lib/ai-api.ts`, `apps/client/src/lib/settings-api.ts`, `apps/client/src/pages/settings/SettingsPage.tsx`, `pages/settings/AiTab.tsx`, `pages/settings/ProviderCard.tsx`, `pages/settings/ModelSlotRow.tsx`, `pages/settings/StorageTab.tsx`
- Modify: `apps/client/src/App.tsx`
- Test: `apps/client/src/lib/ai-api.test.ts`, `apps/client/src/lib/settings-api.test.ts`, `apps/client/src/pages/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `api.get`, `api.json` from `lib/api.ts`. `GET /api/ai/providers`, `POST /api/ai/providers/:id/test`, `GET /api/ai/providers/:id/models`, `GET /api/settings`, `PUT /api/settings` from server routes.
- Produces:
  - `aiApi.providers()`, `aiApi.testProvider(id)`, `aiApi.models(id)`.
  - `settingsApi.list()`, `settingsApi.update(updates)`.
  - `<SettingsPage>` component routed at `/settings`.

- [ ] **Step 1: Add the Select component via shadcn CLI**

Run:
```bash
cd apps/client && source ~/.nvm/nvm.sh && nvm use 22 && corepack enable && pnpm dlx shadcn@latest add select --yes
```

If the CLI does not produce a `select.tsx`, create it manually following the existing shadcn component patterns. The exact implementation depends on the shadcn version.

- [ ] **Step 2: Write the tabs-nav component**

`apps/client/src/components/ui/tabs-nav.tsx`:
```tsx
import * as React from "react";
import { Tabs } from "@base-ui/react/tabs";
import { cn } from "cn";

function TabsNav({ className, ...props }: React.ComponentProps<typeof Tabs.Root>) {
  return <Tabs.Root className={cn("flex flex-col gap-4", className)} {...props} />;
}

function TabsNavList({ className, ...props }: React.ComponentProps<typeof Tabs.List>) {
  return (
    <Tabs.List
      className={cn(
        "inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsNavTab({ className, ...props }: React.ComponentProps<typeof Tabs.Tab>) {
  return (
    <Tabs.Tab
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow",
        className,
      )}
      {...props}
    />
  );
}

function TabsNavPanel({ className, ...props }: React.ComponentProps<typeof Tabs.Panel>) {
  return (
    <Tabs.Panel
      className={cn("mt-2 ring-offset-background focus-visible:outline-none", className)}
      {...props}
    />
  );
}

export { TabsNav, TabsNavList, TabsNavTab, TabsNavPanel };
```

- [ ] **Step 3: Write the API client modules**

`apps/client/src/lib/settings-api.ts`:
```ts
import { api } from "./api";

export type ResolvedSetting = {
  key: string;
  value: unknown;
  source: "db" | "env" | "default" | "unset";
  secret: boolean;
  doc: string;
};

export const settingsApi = {
  async list() {
    return (await api.get<{ settings: ResolvedSetting[] }>("/api/settings")).settings;
  },
  async update(updates: Record<string, unknown>) {
    return (await api.json<{ settings: ResolvedSetting[] }>("PUT", "/api/settings", { updates })).settings;
  },
};
```

`apps/client/src/lib/ai-api.ts`:
```ts
import { api } from "./api";

export type ProviderInfo = {
  id: string;
  label: string;
  adapter: string;
  defaultBaseUrl: string;
  requiresKey: boolean;
  capabilities: { text: boolean; structured: boolean; embeddings: boolean; listModels: boolean };
  suggestedModels: { rules?: string; chat?: string; embedding?: string };
  guide: { title: string; intro: string; steps: { text: string; link?: string; copyValue?: string }[]; notes: string[] };
  keySet: boolean;
  keyLastFour?: string;
  baseUrl: { value: string; source: string };
};

export type SlotInfo = {
  value: string;
  source: string;
  suggestion?: string;
};

export type ModelInfo = {
  id: string;
  label: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  supportsStructured?: boolean;
};

export type TestResult = { ok: boolean; latencyMs: number; message: string };

export const aiApi = {
  async providers() {
    return api.get<{ providers: ProviderInfo[]; slots: Record<string, SlotInfo> }>("/api/ai/providers");
  },
  async testProvider(id: string) {
    return api.json<TestResult>("POST", `/api/ai/providers/${id}/test`, {});
  },
  async models(id: string) {
    return api.get<{ models: ModelInfo[]; error?: string }>(`/api/ai/providers/${id}/models`);
  },
};
```

- [ ] **Step 4: Write the API client tests**

`apps/client/src/lib/settings-api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsApi } from "./settings-api";

afterEach(() => vi.restoreAllMocks());

describe("settingsApi", () => {
  it("lists settings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ settings: [{ key: "test", value: "ok" }] }), { status: 200 }),
    );
    const result = await settingsApi.list();
    expect(result).toEqual([{ key: "test", value: "ok" }]);
  });

  it("updates settings", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ settings: [{ key: "test", value: "new" }] }), { status: 200 }),
    );
    const result = await settingsApi.update({ test: "new" });
    expect(result).toEqual([{ key: "test", value: "new" }]);
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("PUT");
  });
});
```

`apps/client/src/lib/ai-api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiApi } from "./ai-api";

afterEach(() => vi.restoreAllMocks());

describe("aiApi", () => {
  it("fetches providers and slots", async () => {
    const body = { providers: [{ id: "openrouter" }], slots: { rules: { value: "" } } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await aiApi.providers();
    expect(result.providers[0]?.id).toBe("openrouter");
  });

  it("tests a provider", async () => {
    const body = { ok: true, latencyMs: 100, message: "Connected." };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await aiApi.testProvider("openrouter");
    expect(result.ok).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/ai/providers/openrouter/test");
  });

  it("fetches models for a provider", async () => {
    const body = { models: [{ id: "model-1", label: "Model 1" }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await aiApi.models("openrouter");
    expect(result.models[0]?.id).toBe("model-1");
  });
});
```

- [ ] **Step 5: Write the ProviderCard component**

`apps/client/src/pages/settings/ProviderCard.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { aiApi, type ProviderInfo, type TestResult } from "@/lib/ai-api";
import { settingsApi } from "@/lib/settings-api";

export function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const [showKeyField, setShowKeyField] = useState(!provider.keySet);
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [showBaseUrlField, setShowBaseUrlField] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const saveKey = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.${provider.id}.apiKey`]: keyInput });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setKeyInput("");
      setShowKeyField(false);
      toast.success("Key saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearKey = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.${provider.id}.apiKey`]: "" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setShowKeyField(true);
      toast.success("Key cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveBaseUrl = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.${provider.id}.baseUrl`]: baseUrlInput || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setShowBaseUrlField(false);
      toast.success("Base URL saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: () => aiApi.testProvider(provider.id),
    onSuccess: (result) => setTestResult(result),
    onError: (e: Error) => setTestResult({ ok: false, latencyMs: 0, message: e.message }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{provider.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {/* API Key */}
            {provider.requiresKey && (
              <div className="space-y-1.5">
                <Label>API Key</Label>
                {provider.keySet && !showKeyField ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Set, ends in {provider.keyLastFour ? `····${provider.keyLastFour}` : "****"}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setShowKeyField(true)}>Replace</Button>
                    <Button size="sm" variant="outline" onClick={() => clearKey.mutate()} disabled={clearKey.isPending}>Clear</Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="Paste your API key"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                    <Button size="sm" onClick={() => saveKey.mutate()} disabled={!keyInput || saveKey.isPending}>Save</Button>
                    {provider.keySet && (
                      <Button size="sm" variant="outline" onClick={() => setShowKeyField(false)}>Cancel</Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Base URL */}
            <div className="space-y-1.5">
              <Label>Base URL</Label>
              {!showBaseUrlField ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground truncate max-w-xs">{provider.baseUrl.value || "(not set)"}</span>
                  {provider.baseUrl.source === "env" && <Badge variant="secondary">from environment</Badge>}
                  <Button size="sm" variant="outline" onClick={() => { setBaseUrlInput(provider.baseUrl.value); setShowBaseUrlField(true); }}>
                    Edit
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    placeholder={provider.defaultBaseUrl || "https://..."}
                    value={baseUrlInput}
                    onChange={(e) => setBaseUrlInput(e.target.value)}
                  />
                  <Button size="sm" onClick={() => saveBaseUrl.mutate()} disabled={saveBaseUrl.isPending}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setShowBaseUrlField(false)}>Cancel</Button>
                </div>
              )}
            </div>

            {/* Test */}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                {test.isPending ? "Testing..." : "Test"}
              </Button>
              {testResult && (
                <span className={`text-sm ${testResult.ok ? "text-green-600" : "text-destructive"}`}>
                  {testResult.ok ? `OK (${testResult.latencyMs}ms)` : testResult.message}
                </span>
              )}
            </div>
          </div>

          {/* Guide */}
          <div className="space-y-2 text-sm">
            <p className="font-medium">{provider.guide.title}</p>
            <p className="text-muted-foreground">{provider.guide.intro}</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              {provider.guide.steps.map((step, i) => (
                <li key={i}>
                  {step.text}
                  {step.link && (
                    <>
                      {" "}
                      <a href={step.link} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        Open
                      </a>
                    </>
                  )}
                  {step.copyValue && (
                    <>
                      {" "}
                      <button
                        className="underline underline-offset-2 text-foreground"
                        onClick={() => { navigator.clipboard.writeText(step.copyValue!); toast.success("Copied"); }}
                      >
                        Copy
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ol>
            {provider.guide.notes.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1 pt-1 border-t">
                {provider.guide.notes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Write the ModelSlotRow component**

`apps/client/src/pages/settings/ModelSlotRow.tsx`:
```tsx
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aiApi, type ProviderInfo, type SlotInfo, type ModelInfo } from "@/lib/ai-api";
import { settingsApi } from "@/lib/settings-api";

const SLOT_LABELS: Record<string, string> = {
  rules: "Rules (sorting)",
  chat: "Chat",
  embedding: "Embedding",
};

export function ModelSlotRow({
  slot,
  slotInfo,
  providers,
}: {
  slot: string;
  slotInfo: SlotInfo;
  providers: ProviderInfo[];
}) {
  const queryClient = useQueryClient();

  // Parse current value
  const currentUri = typeof slotInfo.value === "string" ? slotInfo.value : "";
  const parts = currentUri.match(/^([a-z0-9_-]+):\/\/(.+)$/);
  const currentProviderId = parts?.[1] ?? "";
  const currentModel = parts?.[2] ?? "";

  const [selectedProvider, setSelectedProvider] = useState(currentProviderId || providers[0]?.id || "");
  const [modelInput, setModelInput] = useState(currentModel);

  useEffect(() => {
    if (currentProviderId) setSelectedProvider(currentProviderId);
    if (currentModel) setModelInput(currentModel);
  }, [currentProviderId, currentModel]);

  // Fetch models for the selected provider
  const { data: modelsData } = useQuery({
    queryKey: ["ai-models", selectedProvider],
    queryFn: () => aiApi.models(selectedProvider),
    enabled: !!selectedProvider,
    staleTime: 10 * 60 * 1000,
  });

  // Get the suggestion placeholder
  const suggestionParts = slotInfo.suggestion?.match(/^([a-z0-9_-]+):\/\/(.+)$/);
  const suggestedModel = suggestionParts?.[2] ?? "";

  const save = useMutation({
    mutationFn: async () => {
      const value = modelInput ? `${selectedProvider}://${modelInput}` : "";
      await settingsApi.update({ [`ai.model.${slot}`]: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      toast.success("Model saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clear = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.model.${slot}`]: "" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setModelInput("");
      toast.success("Model cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="space-y-1 min-w-0">
        <Label>{SLOT_LABELS[slot] ?? slot}</Label>
        <div className="flex gap-2">
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            value={selectedProvider}
            onChange={(e) => { setSelectedProvider(e.target.value); setModelInput(""); }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <Input
            placeholder={suggestedModel || "Model name"}
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            list={`models-${slot}`}
            className="flex-1"
          />
          {modelsData?.models && modelsData.models.length > 0 && (
            <datalist id={`models-${slot}`}>
              {modelsData.models.map((m: ModelInfo) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </datalist>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
        {currentUri && (
          <Button size="sm" variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending}>Clear</Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write the StorageTab component**

`apps/client/src/pages/settings/StorageTab.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { settingsApi, type ResolvedSetting } from "@/lib/settings-api";

export function StorageTab() {
  const queryClient = useQueryClient();
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.list(),
  });

  const storageSettings = settings.filter((s) => s.key.startsWith("storage."));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {storageSettings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No storage settings found.</p>
          ) : (
            storageSettings.map((setting) => (
              <StorageField key={setting.key} setting={setting} queryClient={queryClient} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StorageField({ setting, queryClient }: { setting: ResolvedSetting; queryClient: ReturnType<typeof useQueryClient> }) {
  const [value, setValue] = useState(String(setting.value ?? ""));
  const [editing, setEditing] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [setting.key]: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setEditing(false);
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shortKey = setting.key.replace(/^storage\./, "");

  return (
    <div className="space-y-1.5">
      <Label>{shortKey}</Label>
      <p className="text-xs text-muted-foreground">{setting.doc}</p>
      {!editing ? (
        <div className="flex items-center gap-2">
          <span className="text-sm">{String(setting.value ?? "(not set)")}</span>
          {setting.source === "env" && <Badge variant="secondary">from environment</Badge>}
          {setting.source === "default" && <Badge variant="secondary">default</Badge>}
          <Button size="sm" variant="outline" onClick={() => { setValue(String(setting.value ?? "")); setEditing(true); }}>Edit</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Write the AiTab component**

`apps/client/src/pages/settings/AiTab.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { aiApi } from "@/lib/ai-api";
import { ProviderCard } from "./ProviderCard";
import { ModelSlotRow } from "./ModelSlotRow";

export function AiTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: () => aiApi.providers(),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data) return null;

  const { providers, slots } = data;

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Providers</h2>
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Model slots</h2>
        <p className="text-sm text-muted-foreground">
          Pick a provider and model for each task. The rules slot must use a model that supports structured output.
        </p>
        {Object.entries(slots).map(([slot, info]) => (
          <ModelSlotRow key={slot} slot={slot} slotInfo={info} providers={providers} />
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 9: Write the SettingsPage component**

`apps/client/src/pages/settings/SettingsPage.tsx`:
```tsx
import { TabsNav, TabsNavList, TabsNavTab, TabsNavPanel } from "@/components/ui/tabs-nav";
import { AiTab } from "./AiTab";
import { StorageTab } from "./StorageTab";

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <TabsNav defaultValue="ai">
        <TabsNavList>
          <TabsNavTab value="ai">AI</TabsNavTab>
          <TabsNavTab value="storage">Storage</TabsNavTab>
        </TabsNavList>
        <TabsNavPanel value="ai">
          <AiTab />
        </TabsNavPanel>
        <TabsNavPanel value="storage">
          <StorageTab />
        </TabsNavPanel>
      </TabsNav>
    </div>
  );
}
```

- [ ] **Step 10: Wire the SettingsPage into App.tsx**

In `apps/client/src/App.tsx`:

Replace the import and route:
```tsx
import { SettingsPage } from "@/pages/settings/SettingsPage";
```

Replace `<Route path="/settings" element={<Placeholder title="Settings" />} />` with:
```tsx
<Route path="/settings" element={<SettingsPage />} />
```

Remove the `Placeholder` component if it is no longer used by any route. The `/rules` route still uses it, so keep it.

- [ ] **Step 11: Write the page test**

`apps/client/src/pages/settings/SettingsPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

vi.mock("@/lib/ai-api", () => ({
  aiApi: {
    providers: vi.fn(async () => ({
      providers: [
        {
          id: "openrouter",
          label: "OpenRouter",
          adapter: "openai-compatible",
          defaultBaseUrl: "https://openrouter.ai/api/v1",
          requiresKey: true,
          capabilities: { text: true, structured: true, embeddings: true, listModels: true },
          suggestedModels: { rules: "google/gemini-2.0-flash-001", chat: "anthropic/claude-sonnet-4" },
          guide: { title: "Set up OpenRouter", intro: "Get started.", steps: [{ text: "Step 1" }], notes: [] },
          keySet: true,
          keyLastFour: "abcd",
          baseUrl: { value: "https://openrouter.ai/api/v1", source: "default" },
        },
      ],
      slots: {
        rules: { value: "", source: "default", suggestion: "openrouter://google/gemini-2.0-flash-001" },
        chat: { value: "", source: "default", suggestion: "openrouter://anthropic/claude-sonnet-4" },
        embedding: { value: "", source: "default" },
      },
    })),
    testProvider: vi.fn(async () => ({ ok: true, latencyMs: 42, message: "Connected." })),
    models: vi.fn(async () => ({ models: [] })),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    list: vi.fn(async () => [
      { key: "storage.activeDriver", value: "local", source: "default", secret: false, doc: "Active storage driver." },
      { key: "storage.local.root", value: "./documents", source: "default", secret: false, doc: "Storage root." },
    ]),
    update: vi.fn(async () => []),
  },
}));

describe("SettingsPage", () => {
  it("shows AI tab with a provider card and the key status", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <SettingsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText(/Set, ends in/)).toBeInTheDocument();
    expect(screen.getByText(/abcd/)).toBeInTheDocument();
  });

  it("shows model slot rows", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <SettingsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Rules (sorting)")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Embedding")).toBeInTheDocument();
  });
});
```

- [ ] **Step 12: Run the client tests**

Run: `pnpm --filter @docmind/client test`
Expected: PASS.

- [ ] **Step 13: Run the full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/client/src/components/ui/tabs-nav.tsx \
        apps/client/src/components/ui/select.tsx \
        apps/client/src/lib/ai-api.ts \
        apps/client/src/lib/ai-api.test.ts \
        apps/client/src/lib/settings-api.ts \
        apps/client/src/lib/settings-api.test.ts \
        apps/client/src/pages/settings/ \
        apps/client/src/App.tsx \
        apps/client/package.json \
        pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(client): add settings page with AI providers and Storage tabs

Settings page at /settings with two tabs. AI tab shows one card per
provider (key status, base URL, test, setup guide) and three model
slot rows (provider dropdown, model input with datalist from the models
endpoint). Storage tab shows the active driver and local root settings.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: <session url from the harness>
EOF
)"
```

---

### Task 8: Final tests, user note for .env.example, and manual checklist

**Files:**
- None modified. `.env.example` is off-limits to agents (permission rule).

**Interfaces:**
- Consumes: Everything from Tasks 1 through 7.
- Produces: A note for the user and a manual check list.

- [ ] **Step 1: Run full test suites**

Run:
```bash
pnpm --filter @docmind/server test
pnpm --filter @docmind/client test
pnpm typecheck
```
Expected: All PASS.

- [ ] **Step 2: Tell the user to update `.env.example`**

The agent cannot read or edit `.env.example` (permission rule). Ask the user to add these lines to `apps/server/.env.example` after the existing entries:

```
# --- AI Providers (optional, at least one needed for sorting) ---
# OPENROUTER_API_KEY=sk-or-v1-...
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# OLLAMA_BASE_URL=http://localhost:11434/v1
# LMSTUDIO_BASE_URL=http://localhost:1234/v1
# AI_MODEL_RULES=openrouter://google/gemini-2.0-flash-001
# AI_MODEL_CHAT=openrouter://anthropic/claude-sonnet-4
# AI_MODEL_EMBEDDING=openrouter://openai/text-embedding-3-small
```

The user commits this change themselves.

- [ ] **Step 3: Manual check (with the user's real OpenRouter key)**

Before testing, verify the suggested model IDs against the live OpenRouter models list
(`GET https://openrouter.ai/api/v1/models`). If any model id is no longer available,
update the corresponding provider definition's `suggestedModels` and the `.env.example`
lines before proceeding.

1. Start the dev server: `pnpm dev`.
2. Open http://localhost:5173, sign in.
3. Navigate to Settings.
4. On the AI tab, paste a real OpenRouter key into the OpenRouter card. Click Save.
5. Click Test. Verify "OK" with latency appears.
6. The key field should show "Set, ends in ····xxxx" (last four of the key).
7. Under Model slots, the Rules slot's model input should show a datalist when you start typing (populated from the OpenRouter models endpoint).
8. Set Rules to `openrouter://google/gemini-2.0-flash-001` and Save. It should succeed.
9. Try setting Rules to `anthropic://some-model` without an Anthropic key. It should show an error about the missing key.
10. Switch to the Storage tab. Verify the active driver and local root fields appear with their defaults.
11. Clear the OpenRouter key. Verify the field resets to the paste-your-key state.

---

## Plan review rulings

Applied by plan-reviewer on 2026-09-16. Each ruling references the finding that prompted it.

1. **B1 fixed: OpenRouter `require_parameters` passed wrong.** Task 3 adapter code spread `{ body: extraBody }` into the params object, adding a `"body"` JSON key instead of the intended top-level `require_parameters`. Fixed: pass `{ body: { require_parameters: true } }` as the second argument to `client.chat.completions.create()` (the SDK `RequestOptions`). Verified against `openai@7.17.0` types.
2. **B2 fixed: `getCredentials` crashes for providers without an `apiKey` setting.** `settingsService.get("ai.ollama.apiKey")` throws `settings.unknown_key` because Ollama and LM Studio register no apiKey setting. Fixed: `getCredentials` now checks `provider.settings.some(s => s.key.endsWith(".apiKey"))` before querying.
3. **B3 fixed: Module evaluation order breaks provider settings registration.** `providers/index.ts` pushed settings into `aiSettingDefinitions` as a side effect, but `allSettingDefinitions` spreads the array before that side effect runs. Fixed: `ai.settings.ts` now imports `aiProviderRegistry` and flatMaps its settings, matching the `storageSettingDefinitions` pattern. `providers/index.ts` no longer mutates the settings array.
4. **M1 fixed: Decision 6 said `messages.parse()` but code uses `messages.create()`.** Updated Decision 6 to match the code. Both work; `.create()` is simpler since we validate with valibot.
5. **M2 fixed: Route tests make real HTTP requests.** Task 6 route tests now stub `fetch` globally with `vi.stubGlobal`, returning a minimal models response. No network access.
6. **M3 fixed: Duplicate `SetupGuide` types.** `ai.types.ts` now imports `SetupGuide` and `SetupGuideStep` from `storage.types.ts` instead of redefining them.
7. **m1 fixed: Task 8 edits `.env.example` in violation of the permission rule.** Replaced with a user note listing the exact lines to add. The user commits this change.
8. **Ruling: Suggested model IDs are unverifiable at review time.** The manual check step (Task 8 Step 3) now requires verifying them against the live OpenRouter models list before testing.
9. **Ruling: Custom provider with `requiresKey: true` blocks keyless custom APIs.** Accepted for v1. Workaround: user can enter a dummy key. A future refinement can make the key optional.
