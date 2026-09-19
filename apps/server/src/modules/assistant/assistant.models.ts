import { createError } from "../../shared/errors/errors.js";
import type { AssistantSurface, ToolContext } from "./assistant.types.js";

// textDocumentName, missingNoteTextReply and newThreadReply moved here from
// telegram.models.ts: /note and the saveNote tool share the first two, /new and the
// startNewThread tool share the third, and the assistant module is where both a slash
// command and a model-chosen tool now meet. Telegram imports them back from here.

// A text note has no filename at all, so it is titled from its own first line until
// the summary model retitles it, the same gap a nameless browser upload would have.
export function textDocumentName(text: string): string {
  const firstLine = text.split(/\r?\n/)[0]!.trim();
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}...` : firstLine;
  return `${short || "Note"}.txt`;
}

// /note with nothing after it, or a model call with a blank text argument, should not
// silently file an empty document.
export function missingNoteTextReply(): string {
  return "What do you want me to note? Send /note followed by the text, like /note buy milk.";
}

export function newThreadReply(): string {
  return "Starting fresh. What's up?";
}

// Own copies of the two intake reply strings telegram.models.ts already has, read word
// for word the same so /note sounds unchanged to someone using it today (Decision 10 in
// the assistant triage plan). Duplicated rather than imported: importing from telegram
// would make the dependency circular once telegram imports the assistant module.
export function receivedReply(label: string): string {
  return `Got it. Added "${label}" to DocMind.`;
}

export function duplicateReply(label: string): string {
  return `I already have "${label}", so I didn't add it again.`;
}

// A model's clarifying question still reads like one even when the model forgot the
// question mark, since isAnsweringAQuestion (telegram.models.ts) reads the trailing
// mark to tell a real answer from filler on the next turn.
export function ensureQuestionMark(question: string): string {
  const trimmed = question.trim();
  if (trimmed.length === 0) return "?";
  return trimmed.endsWith("?") ? trimmed : `${trimmed}?`;
}

// A note saved from Telegram keeps the source the bot has always used, so the
// finished-document notifier still reports it. A note saved from the app files the
// same way a manual upload does, since the app has no "assistant" source of its own.
export function noteSourceFor(surface: AssistantSurface): "upload" | "telegram" {
  return surface === "telegram" ? "telegram" : "upload";
}

// A handler that needs history or document scope calls this first. sessionId is null
// for a command with nothing to do with the conversation, such as /note, and a handler
// that assumes one anyway must never be reached from there.
export function requireSession(ctx: Pick<ToolContext, "sessionId">): string {
  if (!ctx.sessionId) {
    throw createError({
      code: "assistant.session_required",
      message: "This needs an ongoing conversation, and this command does not have one.",
      status: 400,
    });
  }
  return ctx.sessionId;
}

// The question actually asked, not the model's paraphrase of it: falls back to the
// user's own message when the model's tool call leaves the argument out entirely, or
// hands back nothing but blank space.
export function resolveQuestion({ argument, userMessage }: { argument: string | undefined; userMessage: string }): string {
  const trimmed = argument?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : userMessage;
}
