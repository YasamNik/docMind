import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";
import { DEFAULT_INSTRUCTIONS } from "./assistant.models.js";

// Same once-only shape as telegram.compressedPhotoNoticeSent: settings are key value
// rows, so a flag that must survive a restart needs no migration to add. Exported so
// assistant.usecases.ts never repeats the key as a string literal.
export const TOOLS_UNSUPPORTED_NOTICE_FOR_KEY = "assistant.toolsUnsupportedNoticeFor";

// The instructions document (assistant instructions plan, Decision 1). Named after this
// module, not chat: the assistant module owns the prompt builder, the registry and the
// turn runner, the three things that read this, and the document governs Telegram as
// much as the app's own chat page.
export const INSTRUCTIONS_KEY = "assistant.instructions";
export const INSTRUCTIONS_HISTORY_KEY = "assistant.instructionsHistory";

export const assistantSettingDefinitions: SettingDefinition[] = [
  defineSetting({
    key: TOOLS_UNSUPPORTED_NOTICE_FOR_KEY,
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Model uri the assistant last told the user it could not offer tools for.",
  }),
  // internal: true is what stops PUT /api/settings from writing this without pushing a
  // version (Decision 2 in the assistant instructions plan). The only writers are
  // assistant.usecases.ts's saveInstructions and restoreInstructions, both of which cap
  // and version in one call.
  defineSetting({
    key: INSTRUCTIONS_KEY,
    schema: v.string(),
    internal: true,
    default: DEFAULT_INSTRUCTIONS,
    doc: "The user's standing instructions to the assistant, appended to every turn's prompt.",
  }),
  // No v.maxLength here on purpose, and no cap of any length. resolveRaw
  // (settings.usecases.ts) parses a stored value against this schema on every single
  // read, so a length limit here would apply on read as well as on write: a history
  // that once grew past a cap added later would fail to parse and break every read
  // instead of just one push. The twenty version limit lives in pushInstructionVersion
  // (assistant.models.ts) and is enforced only when a version is pushed.
  defineSetting({
    key: INSTRUCTIONS_HISTORY_KEY,
    schema: v.array(v.object({ body: v.string(), replacedAt: v.string() })),
    internal: true,
    default: [],
    doc: "Previous versions of the user's standing instructions, newest first.",
  }),
];
