import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";

export const tagsSettingDefinitions = [
  defineSetting({
    key: "types.presetsSeeded",
    schema: v.boolean(),
    default: false,
    internal: true,
    doc: "Internal flag marking that the preset document types and the retired documentType field migration have run for this user.",
  }),
];
