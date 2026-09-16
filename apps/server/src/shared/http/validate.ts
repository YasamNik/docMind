import type { Context } from "hono";
import * as v from "valibot";
import { createError } from "../errors/errors.js";

export async function parseJsonBody<S extends v.GenericSchema>(c: Context, schema: S): Promise<v.InferOutput<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw createError({ code: "validation", message: "Body must be JSON", status: 400 });
  }
  return parseOrValidationError(schema, raw);
}

export function parseOrValidationError<S extends v.GenericSchema>(schema: S, value: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    const first = result.issues[0];
    const path = first?.path?.map((p) => String(p.key)).join(".");
    throw createError({
      code: "validation",
      message: `${path ? path + ": " : ""}${first?.message ?? "Invalid input"}`,
      status: 400,
    });
  }
  return result.output;
}
