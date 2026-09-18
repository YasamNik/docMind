import * as v from "valibot";
import { FIELD_KEYS } from "./fields.types.js";

// HTTP input is validated strictly. This is the user's own request, not a model reply,
// so an unknown key here is a client bug worth a 400.
export const fieldKeyQuerySchema = v.picklist(FIELD_KEYS);
