import * as v from "valibot";

export const updateSettingsBodySchema = v.object({
  updates: v.record(v.string(), v.unknown()),
});
