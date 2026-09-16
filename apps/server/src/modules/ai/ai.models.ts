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

const KEY_PATTERN = /\bsk-[a-zA-Z0-9_-]{16,}\b/g;

export function sanitizeProviderError(text: string): string {
  return text.replace(KEY_PATTERN, "[redacted]");
}
