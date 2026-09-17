# Vision LLM OCR Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-tier extraction pipeline for images. Tesseract OCR runs first (free, fast, local). When its page-level confidence falls below a configurable threshold and a vision model slot is configured, the original image is sent to a vision-capable LLM for text extraction. This handles handwriting, poor scans, complex tables, and receipts that Tesseract struggles with.

**Architecture:** The change spans three modules. The extraction module exposes OCR confidence from Tesseract and the extraction usecase orchestrates the fallback decision. The AI module gains a fourth model slot ("vision"), a new `recognizeImage` method on both adapters and the AI service, and a confidence threshold setting. The client gets a label for the new slot. No new tables or columns. No new npm dependencies.

**Branch:** `feat/design-pass` (current branch, or a dedicated branch if preferred).

## Global Constraints

- Node 22 via nvm, pnpm via corepack. Before any pnpm command in a fresh shell: `source ~/.nvm/nvm.sh && nvm use 22 && corepack enable`.
- Every HTTP input, job payload, and LLM reply is parsed with valibot before use.
- All database access through Drizzle. Raw SQL only in migrations and for the FTS5 virtual table and vector operations.
- **No database change.** No new tables, columns, or migrations. Extraction method info is stored in the existing `extractionError` field (which already serves as a note field when status is "done").
- Single libsql connection (`concurrency: 1`): never call a query through the outer `db` handle from inside a `db.transaction(async (tx) => ...)` callback.
- Error codes are asserted in tests through `expectAppError(run, code)` from `apps/server/src/shared/test/errors.test-utils.ts`.
- Module files are named by role. Tests sit next to the file as `*.test.ts`.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- `ref_code/` is reference only. Never copy from it, never import it.
- Conventional commits, subject line first, blank line, then the harness's attribution trailers on their own lines.
- Run server tests with `pnpm --filter @docmind/server test`, client tests with `pnpm --filter @docmind/client test`. Run `pnpm typecheck` from the root before every commit.
- Timestamps are ISO 8601 strings in UTC.

## Decisions

1. **Vision fallback lives in the extraction usecase, not in the image extractor.** The image extractor stays focused: OCR bytes to text with confidence. The usecase checks confidence, resolves the vision slot, calls the AI service, and decides whether to use the vision result. Rationale: the fallback involves AI service, settings, and business logic, which belongs in the orchestration layer. The extractor remains testable with no AI dependency.

2. **`recognizeImage` is a new method on `AiAdapter` and `AiService`, not a modification of existing methods.** Image input is fundamentally different from text-only input (multipart content blocks vs. plain string). A dedicated method keeps the interface explicit and avoids optional-parameter sprawl on `generateStructured` or `streamText`.

3. **The OCR confidence threshold is a user setting, not a constant.** Key: `ai.vision.ocrConfidenceThreshold`, type number 0-100, default 60. Different users scan different document qualities. The default of 60 catches genuinely poor OCR without triggering on every scan.

4. **All providers get `vision: true` in their capabilities.** Both the OpenAI-compatible and Anthropic API formats support multipart messages with image content. Whether a specific model handles images is a model-level concern. If the user picks a non-vision model, the provider returns a clear error.

5. **Graceful degradation on all failure paths.** If the vision slot is not configured, OCR output is used as today with no change. If the vision LLM call fails (network, model error, rate limit), the OCR result is kept and the failure is recorded in the extraction note. The document still reaches "done" status with whatever text OCR produced.

6. **No new database columns.** The extraction method information ("Extracted by vision LLM, OCR confidence was 45") goes into the existing `extractionError` field, which already stores notes when `extractionStatus` is "done". A dedicated `extractionMethod` column is a future improvement.

7. **The vision prompt is a pair of constants in the extraction module.** System prompt and user prompt live in `extraction.models.ts`. They are not configurable settings for now. The prompt instructs the model to extract all text, preserve layout, and return only the text.

8. **Only image extractors trigger the fallback.** The check is confidence-based: if `result.confidence` is defined and below threshold, the fallback triggers. Only the image extractor returns confidence, so PDFs, DOCX, and other formats are unaffected.

9. **`aiService` is an optional dependency of `createExtractionService`.** When absent (tests that don't need vision), the fallback is silently skipped. The dependency is typed as `Pick<AiService, 'recognizeImage'>` to keep the coupling narrow.

10. **`suggestedModels.vision` uses cost-effective vision models.** OpenRouter suggests `google/gemini-2.5-flash` (vision-capable, fast, cheap). OpenAI suggests `gpt-4o-mini`. Anthropic suggests `claude-sonnet-4-20250514`. Other providers leave it undefined.

## Interfaces inherited

- `apps/server/src/modules/extraction/ocr.ts`: `OcrEngine { recognize(bytes, opts): Promise<string>; terminate(): Promise<void> }` -- **Task 1 changes the return type.**
- `apps/server/src/modules/extraction/extraction.types.ts`: `ExtractResult { text: string; note?: string }` -- **Task 1 adds `confidence?: number`.**
- `apps/server/src/modules/extraction/extractors/image.extractor.ts`: `createImageExtractor(engine: OcrEngine): Extractor`.
- `apps/server/src/modules/extraction/extraction.usecases.ts`: `createExtractionService({ db, documentsService, settingsService, registry, rulesService })` -- **Task 4 adds optional `aiService`.**
- `apps/server/src/modules/ai/ai.types.ts`: `AiAdapter`, `AiProviderCapabilities`, `ModelSlot`, `AiProviderDefinition`.
- `apps/server/src/modules/ai/ai.usecases.ts`: `createAiService(...)` returns `AiService`.
- `apps/server/src/modules/ai/adapters/adapter.types.ts`: re-exports `AiAdapter`.
- `apps/server/src/modules/ai/ai.models.ts`: `MODEL_SLOTS`, `parseModelUri`, `buildModelUri`.
- `apps/server/src/modules/ai/ai.schemas.ts`: `modelSlotSchema`.
- `apps/server/src/modules/ai/ai.settings.ts`: `aiSlotSettingDefinitions`, `aiSettingDefinitions`.
- `apps/server/src/modules/ai/providers/*.provider.ts`: each exports an `AiProviderDefinition`.
- `apps/server/src/modules/settings/settings.registry.ts`: `defineSetting(...)`.
- `apps/server/src/modules/settings/settings.definitions.ts`: `allSettingDefinitions`.
- `apps/server/src/modules/ai/ai.routes.ts`: `MODEL_SLOTS` iteration, `beforeSet` hook in `server.ts`.
- `apps/server/src/server.ts`: `createServer(...)` wiring.
- `apps/server/src/shared/test/app.test-utils.ts`: `fakeOcrEngine`, `createTestApp(...)`.
- `apps/client/src/pages/settings/ModelSlotRow.tsx`: `SLOT_LABELS`.

---

## Task 1: Expose OCR confidence from Tesseract

**Goal:** Change the OCR engine and image extractor to surface Tesseract's page-level confidence score (0-100) alongside the extracted text. No behavior change yet, just data plumbing.

### Files touched

| File | Change |
|------|--------|
| `apps/server/src/modules/extraction/ocr.ts` | New `OcrResult` type, change `recognize` return to `Promise<OcrResult>` |
| `apps/server/src/modules/extraction/extraction.types.ts` | Add `confidence?: number` to `ExtractResult` |
| `apps/server/src/modules/extraction/extractors/image.extractor.ts` | Read confidence from `OcrResult`, set it on `ExtractResult` |
| `apps/server/src/modules/extraction/ocr.test.ts` | Update fake worker to return `{ data: { text, confidence } }`, assert confidence flows through |
| `apps/server/src/modules/extraction/extractors/image.extractor.test.ts` | Update fake engine, assert confidence on result |
| `apps/server/src/shared/test/app.test-utils.ts` | Update `fakeOcrEngine.recognize` to return `OcrResult` |

### Steps

- [ ] **1.1** In `ocr.ts`, define `OcrResult = { text: string; confidence: number }`. Change `OcrEngine.recognize` return type from `Promise<string>` to `Promise<OcrResult>`. In `createTesseractEngine`, return `{ text: result.data.text, confidence: result.data.confidence }` instead of `result.data.text`.

- [ ] **1.2** In `extraction.types.ts`, add `confidence?: number` to `ExtractResult`. This is the Tesseract page-level confidence on a 0-100 scale.

- [ ] **1.3** In `image.extractor.ts`, destructure `{ text: rawText, confidence }` from `engine.recognize(...)`. Set `confidence` on the returned `ExtractResult`. When no text is recognized (empty after normalize), still return `confidence` so the fallback can decide.

- [ ] **1.4** Update `ocr.test.ts`: fake workers return `{ data: { text: "ok", confidence: 95 } }`. Add an assertion that confidence is propagated.

- [ ] **1.5** Update `image.extractor.test.ts`: fake engines return `{ text: "...", confidence: 85 }`. Assert confidence appears on the result.

- [ ] **1.6** Update `app.test-utils.ts`: change `fakeOcrEngine.recognize` to return `{ text: "OCR TEXT", confidence: 95 }`.

- [ ] **1.7** Run `pnpm --filter @docmind/server test` and `pnpm typecheck`. Fix any type errors from the changed return type.

### Test strategy

- Unit: `ocr.test.ts` verifies confidence flows from the Tesseract worker result.
- Unit: `image.extractor.test.ts` verifies confidence appears on `ExtractResult`.
- Integration: existing `extraction.usecases.test.ts` still passes (confidence is an additive optional field).

### Commit message

```
feat(server): expose OCR confidence from Tesseract engine

Change OcrEngine.recognize return type from string to OcrResult
{ text, confidence }. The image extractor forwards confidence on
ExtractResult so the extraction usecase can decide whether to
invoke the vision LLM fallback.
```

---

## Task 2: Vision model slot, settings, and provider capabilities

**Goal:** Add the fourth model slot ("vision"), a confidence threshold setting, and the `vision` capability flag on all providers. Update the client label map. After this task, the vision slot appears on the Settings page but nothing uses it yet.

### Files touched

| File | Change |
|------|--------|
| `apps/server/src/modules/ai/ai.types.ts` | Add `"vision"` to `ModelSlot`, add `vision` to `AiProviderCapabilities` |
| `apps/server/src/modules/ai/ai.models.ts` | Add `"vision"` to `MODEL_SLOTS` |
| `apps/server/src/modules/ai/ai.schemas.ts` | Add `"vision"` to `modelSlotSchema` picklist |
| `apps/server/src/modules/ai/ai.settings.ts` | Add `ai.model.vision` slot setting, add `ai.vision.ocrConfidenceThreshold` setting |
| `apps/server/src/modules/ai/providers/*.provider.ts` | Add `vision: true` to capabilities, add `suggestedModels.vision` where appropriate |
| `apps/server/src/modules/ai/providers/providers.test.ts` | Update capability assertions |
| `apps/server/src/modules/ai/ai.models.test.ts` | Assert MODEL_SLOTS includes "vision" |
| `apps/server/src/modules/ai/ai.settings.test.ts` | Assert new settings exist |
| `apps/server/src/server.ts` | Add `vision` slot validation in `beforeSet` hook |
| `apps/client/src/pages/settings/ModelSlotRow.tsx` | Add `vision: "Vision (OCR fallback)"` to `SLOT_LABELS` |

### Steps

- [ ] **2.1** In `ai.types.ts`, change `ModelSlot` to `"rules" | "chat" | "embedding" | "vision"`. Add `vision: boolean` to `AiProviderCapabilities`. Add `vision?: string` to `suggestedModels` in `AiProviderDefinition`.

- [ ] **2.2** In `ai.models.ts`, add `"vision"` to the `MODEL_SLOTS` array.

- [ ] **2.3** In `ai.schemas.ts`, add `"vision"` to the `modelSlotSchema` picklist.

- [ ] **2.4** In `ai.settings.ts`, add two new settings to `aiSlotSettingDefinitions`:
  - `ai.model.vision`: same schema as other slots (union of modelUriSchema and literal ""), env `AI_MODEL_VISION`, default `""`, doc: "Model for vision-based text extraction from images. Used as a fallback when OCR confidence is low. Format: provider://model"
  - `ai.vision.ocrConfidenceThreshold`: schema `v.pipe(v.number(), v.minValue(0), v.maxValue(100))`, env `AI_VISION_OCR_CONFIDENCE_THRESHOLD`, default `60`, doc: "When Tesseract OCR confidence falls below this value (0-100), the vision model is called as a fallback. Only applies to image documents."

- [ ] **2.5** Update all eight provider definitions in `apps/server/src/modules/ai/providers/`:
  - Add `vision: true` to capabilities for all providers.
  - Add `suggestedModels.vision` for: OpenRouter (`google/gemini-2.5-flash`), OpenAI (`gpt-4o-mini`), Anthropic (`claude-sonnet-4-20250514`). Leave undefined for Ollama, Mistral, DeepSeek, LM Studio, Custom.

- [ ] **2.6** In `server.ts`, extend the `beforeSet` hook to validate the vision slot. Add a case: if `slot === "vision"` and `!provider.capabilities.vision`, throw `ai.capability_missing` with message about vision support. (Since all providers have `vision: true` today, this is future-proofing.)

- [ ] **2.7** In `ModelSlotRow.tsx` on the client, add `vision: "Vision (OCR fallback)"` to `SLOT_LABELS`.

- [ ] **2.8** Update `providers.test.ts` to assert `vision: true` in capabilities. Update `ai.models.test.ts` to assert `MODEL_SLOTS` contains all four values. Update `ai.settings.test.ts` to assert the two new setting keys exist. Update `ai.routes.test.ts` if it checks the slots response.

- [ ] **2.9** Run `pnpm --filter @docmind/server test`, `pnpm --filter @docmind/client test`, `pnpm typecheck`.

### Test strategy

- Unit: `ai.models.test.ts` checks MODEL_SLOTS array contents.
- Unit: `ai.settings.test.ts` checks new setting definitions (key, default, env).
- Unit: `providers.test.ts` checks all providers have `vision` in capabilities.
- Integration: `ai.routes.test.ts` checks the providers endpoint returns the vision slot.
- Client: `ModelSlotRow.test.tsx` renders the label correctly if it tests labels.

### Commit message

```
feat(server,client): add vision model slot and OCR confidence threshold setting

Fourth model slot "vision" for image-based text extraction. When
configured, it serves as a fallback when Tesseract OCR confidence
is low. Default threshold is 60. All providers declare vision
capability since both adapter formats support multipart image
messages.
```

---

## Task 3: Adapter `recognizeImage` method and AI service

**Goal:** Add a `recognizeImage` method to the `AiAdapter` interface and implement it in both adapters. Add the corresponding method on `AiService` that resolves the vision slot and delegates.

### Files touched

| File | Change |
|------|--------|
| `apps/server/src/modules/ai/ai.types.ts` | Add `VisionResult` type, add `recognizeImage` to `AiAdapter` |
| `apps/server/src/modules/ai/adapters/openai-compatible.adapter.ts` | Implement `recognizeImage` with image_url content part |
| `apps/server/src/modules/ai/adapters/anthropic.adapter.ts` | Implement `recognizeImage` with image source content block |
| `apps/server/src/modules/ai/ai.usecases.ts` | Add `recognizeImage` method to the AI service |
| `apps/server/src/modules/ai/adapters/openai-compatible.adapter.test.ts` | Add test with recorded fixture |
| `apps/server/src/modules/ai/adapters/anthropic.adapter.test.ts` | Add test with recorded fixture |
| `apps/server/src/modules/ai/ai.usecases.test.ts` | Add test for the service-level method |
| `apps/server/src/modules/ai/__fixtures__/` | Add fixture files for vision responses |

### Steps

- [ ] **3.1** In `ai.types.ts`, add:
  ```
  VisionResult = { text: string; usage: { promptTokens: number; completionTokens: number } }
  ```
  Add to `AiAdapter`:
  ```
  recognizeImage(args: {
    model: string;
    system: string;
    prompt: string;
    imageBase64: string;
    mimeType: string;
  }): Promise<VisionResult>;
  ```

- [ ] **3.2** Implement `recognizeImage` in the OpenAI-compatible adapter. Use `client.chat.completions.create` with the user message as an array of content parts:
  ```
  [
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    { type: "text", text: prompt }
  ]
  ```
  Set `max_tokens: 4096`. Return the text from the first choice and usage stats. Wrap errors with `wrapError`.

- [ ] **3.3** Implement `recognizeImage` in the Anthropic adapter. Use `client.messages.create` with user content as:
  ```
  [
    { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
    { type: "text", text: prompt }
  ]
  ```
  Set `max_tokens: 4096`. Extract text from the first text block. Wrap errors.

- [ ] **3.4** Add `recognizeImage` to the AI service in `ai.usecases.ts`. Signature:
  ```
  async recognizeImage({ userId, system, prompt, imageBase64, mimeType }):
    Promise<VisionResult>
  ```
  Resolve the "vision" slot via `resolveSlot(userId, "vision")`. Check `provider.capabilities.vision`. Build adapter. Call `adapter.recognizeImage(...)`. Log with task "vision".

- [ ] **3.5** Create fixture files under `__fixtures__/`: `openrouter-vision.json` and `anthropic-vision.json` with realistic response shapes for a vision completion.

- [ ] **3.6** Add adapter tests: call `recognizeImage` with a tiny base64 PNG, intercept the HTTP request (using the same pattern as existing adapter tests), return the fixture, assert the result text and usage.

- [ ] **3.7** Add AI service test: mock the adapter factory, call `recognizeImage`, assert slot resolution and delegation.

- [ ] **3.8** Run `pnpm --filter @docmind/server test` and `pnpm typecheck`.

### Test strategy

- Unit: adapter tests verify the HTTP request shape (multipart content, correct MIME type, max_tokens) and response parsing.
- Unit: service test verifies slot resolution, capability check, and delegation.
- Fixtures recorded from real API responses (or close approximations) ensure parsing is correct.

### Commit message

```
feat(server): add recognizeImage method to AI adapters and service

Both the OpenAI-compatible and Anthropic adapters can now send
images as base64 content parts in chat messages. The AI service
resolves the "vision" model slot and delegates. This is the
callable layer for the OCR fallback; the extraction pipeline
wires it in the next commit.
```

---

## Task 4: Wire vision fallback into extraction pipeline

**Goal:** When the image extractor reports low OCR confidence and the vision model slot is configured, send the original image to the vision LLM and use its result instead. Record which method produced the text. Gracefully degrade on every failure path.

### Files touched

| File | Change |
|------|--------|
| `apps/server/src/modules/extraction/extraction.models.ts` | Add vision prompt constants |
| `apps/server/src/modules/extraction/extraction.usecases.ts` | Accept optional `aiService`, add fallback logic after extraction |
| `apps/server/src/modules/extraction/extraction.models.test.ts` | Test prompt constants exist |
| `apps/server/src/modules/extraction/extraction.usecases.test.ts` | Add integration tests for vision fallback |
| `apps/server/src/server.ts` | Pass `aiService` to `createExtractionService` |
| `apps/server/src/shared/test/app.test-utils.ts` | No change needed (aiService already exists on the test server) |

### Steps

- [ ] **4.1** In `extraction.models.ts`, add two exported constants:
  - `VISION_SYSTEM_PROMPT = "You are a document text extraction assistant. Your task is to accurately read and transcribe text from document images."`
  - `VISION_USER_PROMPT = "Extract all text from this document image. Preserve the original layout and structure as much as possible. Return only the extracted text, nothing else."`

- [ ] **4.2** In `extraction.usecases.ts`, extend the `createExtractionService` parameter type to accept an optional `aiService`:
  ```
  aiService?: Pick<AiService, 'recognizeImage'>;
  ```
  Import `AiService` type from the AI module.

- [ ] **4.3** In the `extractDocument` function, after `const result = await extractor.extract(...)`, add the vision fallback block:

  a. Read the threshold: `const threshold = await settingsService.get<number>(userId, "ai.vision.ocrConfidenceThreshold") ?? 60`.

  b. Check: `if (aiService && result.confidence !== undefined && result.confidence < threshold)`. If false, skip fallback.

  c. Check if the vision slot is configured: `const visionModel = await settingsService.get<string>(userId, "ai.model.vision")`. If empty or falsy, skip fallback. Add a note: no change (use OCR result as-is).

  d. Try the vision call:
     - Encode image: `const imageBase64 = Buffer.from(bytes).toString("base64")`
     - Call `aiService.recognizeImage({ userId, system: VISION_SYSTEM_PROMPT, prompt: VISION_USER_PROMPT, imageBase64, mimeType: document.mimeType ?? "image/png" })`
     - Normalize the vision text with `normalizeText()`
     - If vision text is non-empty, replace `result.text` and set `result.note` to `"Extracted by vision LLM (OCR confidence was ${result.confidence.toFixed(0)})"`
     - If vision text is empty, keep OCR result and set note: `"Vision LLM returned no text. Using OCR result (confidence: ${result.confidence.toFixed(0)})."`

  e. Catch: if the vision call throws, keep the OCR result. Set `result.note` to `"Vision LLM fallback failed: ${message}. Using OCR result (confidence: ${result.confidence.toFixed(0)})."`

  f. Log at info level whether the fallback was triggered, succeeded, or failed.

- [ ] **4.4** In `server.ts`, pass `aiService` to `createExtractionService`:
  ```
  const extractionService = createExtractionService({
    db, documentsService, settingsService, registry, rulesService, aiService,
  });
  ```

- [ ] **4.5** Add unit test in `extraction.models.test.ts` asserting the prompt constants are non-empty strings.

- [ ] **4.6** Add integration tests in `extraction.usecases.test.ts`:

  a. **"uses vision fallback when OCR confidence is below threshold"**: Create a test app with a custom `ocrEngine` that returns `{ text: "garbled", confidence: 30 }`. Set the vision model slot in settings. Mock the AI adapter's `recognizeImage` to return `{ text: "Clean extracted text", usage: {...} }`. Upload an image, run extraction, assert `extractedText` is "Clean extracted text" and `extractionError` contains "Extracted by vision LLM".

  b. **"keeps OCR result when vision slot is not configured"**: Same low-confidence OCR engine, but no vision model slot set. Assert `extractedText` is "garbled" and `extractionError` is null or empty.

  c. **"keeps OCR result when confidence is above threshold"**: OCR engine returns `{ text: "good text", confidence: 85 }`. Vision slot is configured. Assert `extractedText` is "good text" and the vision adapter was never called.

  d. **"keeps OCR result when vision LLM call fails"**: Low confidence, vision slot set, but AI adapter throws. Assert `extractedText` is "garbled" and `extractionError` contains "Vision LLM fallback failed".

- [ ] **4.7** Run `pnpm --filter @docmind/server test`, `pnpm --filter @docmind/client test`, `pnpm typecheck`.

### Test strategy

- Unit: prompt constants exist (extraction.models.test.ts).
- Integration: four scenarios covering all branches of the fallback logic (extraction.usecases.test.ts).
- Existing tests continue to pass because the `aiService` parameter is optional and `fakeOcrEngine` returns confidence 95 (above default threshold of 60).

### Commit message

```
feat(server): wire vision LLM fallback into image extraction pipeline

When Tesseract OCR confidence falls below the threshold (default 60)
and a vision model slot is configured, the original image is sent to
the vision LLM. The result replaces the low-confidence OCR text.
Falls back gracefully to OCR output on any failure.
```

---

## Verification

After all four tasks are committed:

1. **Typecheck passes:** `pnpm typecheck` from root.
2. **All server tests pass:** `pnpm --filter @docmind/server test`.
3. **All client tests pass:** `pnpm --filter @docmind/client test`.
4. **Manual smoke test:**
   - Start the dev server. Open Settings, AI tab.
   - Verify the "Vision (OCR fallback)" slot appears below the other three.
   - Configure an OpenRouter key, set the vision slot to a vision-capable model.
   - Upload a clear image (e.g., typed document). Verify extraction completes as before (no fallback triggered, OCR confidence should be high).
   - Upload a low-quality image (e.g., handwritten note, blurry receipt). If OCR confidence is below 60, verify the extraction note says "Extracted by vision LLM" and the text quality is better than raw OCR.
   - Clear the vision slot. Upload another low-quality image. Verify extraction completes with OCR text and no vision note.
5. **No regressions:** Documents that are not images (PDF, DOCX, text) continue to extract normally with no confidence check and no vision fallback.

## Risks

1. **Large images as base64.** A 20 MB image becomes ~27 MB of base64 text in the API request. Most providers accept this (OpenAI and Anthropic both allow up to 20 MB images), but it will be slow. Mitigation: the LLM provider's error message is shown if it rejects. A future improvement could resize images before sending.

2. **Vision LLM cost.** Every low-confidence image triggers a paid LLM call. Mitigation: the feature is opt-in (vision slot must be explicitly configured), and the threshold is adjustable. Raising the threshold reduces how often the fallback fires.

3. **Non-vision models selected for the vision slot.** If the user picks a text-only model, the API call will fail with the provider's error. Mitigation: the error is recorded in the extraction note, and the OCR result is preserved. The Settings page shows suggested vision-capable models.

4. **Tesseract confidence may be unreliable for some document types.** Some images with good text may get low confidence (e.g., unusual fonts, colored backgrounds), triggering unnecessary vision calls. Mitigation: the threshold is tunable, and the cost is bounded (one call per image).
