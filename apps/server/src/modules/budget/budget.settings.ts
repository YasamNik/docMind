import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";

export const budgetSettingDefinitions = [
  defineSetting({
    key: "budget.categoriesSeeded",
    schema: v.boolean(),
    default: false,
    internal: true,
    doc: "Internal flag marking that the preset budget categories have been seeded for this user.",
  }),
];
