import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";

// Same once-only shape as telegram.compressedPhotoNoticeSent: settings are key value
// rows, so a flag that must survive a restart needs no migration to add. Exported so
// assistant.usecases.ts never repeats the key as a string literal.
export const TOOLS_UNSUPPORTED_NOTICE_FOR_KEY = "assistant.toolsUnsupportedNoticeFor";

export const assistantSettingDefinitions: SettingDefinition[] = [
  defineSetting({
    key: TOOLS_UNSUPPORTED_NOTICE_FOR_KEY,
    schema: v.string(),
    internal: true,
    default: "",
    doc: "Model uri the assistant last told the user it could not offer tools for.",
  }),
];
