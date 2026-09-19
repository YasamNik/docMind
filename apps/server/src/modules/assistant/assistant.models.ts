import { createError } from "../../shared/errors/errors.js";
import type { ToolDefinition } from "../ai/ai.types.js";
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

// The system prompt for a turn that can call a tool (assistant.usecases.ts, runTurn).
// Built from the same records the adapters turn into wire-level tool specs, so a new
// capability widens what the model is told about the moment it joins the registry,
// with no line here ever naming which tool it is. basePrompt is the surface's own
// prompt (TELEGRAM_ASSISTANT_SYSTEM_PROMPT today, CHAT_SYSTEM_PROMPT once plan 5 merges
// the two), kept as an argument rather than hard-coded so that merge stays a one line
// change at the call site instead of a rewrite here.
export function buildAssistantPrompt({
  basePrompt,
  tools,
  writesWithheld,
}: {
  basePrompt: string;
  tools: ToolDefinition[];
  writesWithheld: boolean;
}): string {
  const toolLines = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  const sections = [
    basePrompt,
    `You can act on the user's message by calling one of the tools below. Call at most one per message, only when it clearly fits what was asked; otherwise just reply in plain text.\n\n${toolLines}`,
  ];
  if (writesWithheld) {
    sections.push(
      "You cannot save or write anything yourself right now. If someone asks you to save, note down, or remember something in writing, tell them to send /note followed by the text, for example /note buy milk. Never claim to have saved something you did not.",
    );
  }
  return sections.join("\n\n");
}

// Said once per configured chat model uri (Decision 9 in the assistant triage plan), not
// once ever and not on every turn: the settings flag that remembers which model this was
// last said for lives in assistant.settings.ts.
export function toolsUnsupportedNotice(): string {
  return "Heads up, the chat model configured right now does not support tools, so I can only answer from your documents. Switch the chat model in Settings to get the rest back.";
}

// The assistant's own generic failure reply, distinct from telegram.models.ts's
// assistantTroubleReply (Decision 10 in the assistant triage plan): read differently on
// purpose, since the two modules keep their own copies rather than one importing the
// other.
export function assistantTroubleReply(): string {
  return "That did not work on my end. Try sending it again in a moment.";
}

// A tool-agnostic label for the user's half of a recorded command exchange
// (assistant.usecases.ts, runCommand), so the turn runner never has to know which
// capability's schema uses which field name. Every capability that records a turn takes
// its main instruction as a single string argument; anything else falls back to the
// bare command name so the history still shows something legible.
export function commandTurnText({ tool, args }: { tool: string; args: unknown }): string {
  if (args && typeof args === "object") {
    for (const value of Object.values(args as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return `/${tool}`;
}
