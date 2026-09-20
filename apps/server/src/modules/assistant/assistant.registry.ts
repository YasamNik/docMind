import { Readable } from "node:stream";
import * as v from "valibot";
import type { GenericSchema } from "valibot";
import { isAppError } from "../../shared/errors/errors.js";
import { parseCitations } from "../chat/chat.models.js";
import {
  appendInstructionLine,
  ASSISTANT_ANSWERING_SYSTEM_PROMPT,
  duplicateReply,
  ensureQuestionMark,
  instructionAddedReply,
  missingNoteTextReply,
  newThreadReply,
  noteSourceFor,
  quotedForConfirmation,
  receivedReply,
  requireSession,
  resolveQuestion,
  textDocumentName,
  withInstructions,
} from "./assistant.models.js";
import type { Capability, ToolContext, ToolResult } from "./assistant.types.js";

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const piece of stream) text += piece;
  return text;
}

// Mirrors defineSetting in settings.registry.ts: a strongly typed builder so a handler
// is written against its own schema's real argument type, that erases to the
// registry's plain Capability shape, so runTurn and runCommand only ever see one
// handler signature no matter which record they are running.
function defineCapability<S extends GenericSchema>(capability: {
  name: string;
  description: string;
  schema: S;
  writes: boolean;
  destructive: boolean;
  recordsTurn: boolean;
  // The sentence the user is shown before this capability's handler ever runs (assistant
  // confirmation plan). Required in practice for a record that writes or deletes, which
  // "gives every record that writes or deletes a sentence to confirm with" below enforces.
  confirm?: (args: v.InferOutput<S>) => string;
  handler: (args: v.InferOutput<S>, ctx: ToolContext) => Promise<ToolResult>;
}): Capability {
  return capability as unknown as Capability;
}

const answerFromDocuments = defineCapability({
  name: "answerFromDocuments",
  description:
    "Answer the user's question using their own saved documents, such as a policy, invoice, receipt, or note. Use this whenever the question could be answered by something the user has already filed in DocMind.",
  schema: v.object({ question: v.optional(v.string()) }),
  writes: false,
  destructive: false,
  recordsTurn: true,
  async handler({ question }, ctx) {
    const sessionId = requireSession(ctx);
    const resolvedQuestion = resolveQuestion({ argument: question, userMessage: ctx.userMessage });
    const { stream, chunks } = await ctx.services.chat.answerFromDocuments({
      userId: ctx.userId,
      sessionId,
      question: resolvedQuestion,
      systemPrompt: withInstructions(ASSISTANT_ANSWERING_SYSTEM_PROMPT, ctx.instructions),
    });
    const text = await drain(stream);
    return { reply: text, citations: parseCitations(text, chunks) };
  },
});

const saveNote = defineCapability({
  name: "saveNote",
  description:
    "Save the given text as a plain text note in DocMind. Use this only when the user explicitly asks to save, note down, or remember something in writing, never on your own initiative.",
  schema: v.object({ text: v.string() }),
  writes: true,
  destructive: false,
  recordsTurn: false,
  confirm: ({ text }) => `"${quotedForConfirmation(text)}"\n\nSave that as a note?`,
  async handler({ text }, ctx) {
    const trimmed = text.trim();
    if (!trimmed) return { reply: missingNoteTextReply(), citations: [] };
    const { document, duplicateOf } = await ctx.services.documents.upload({
      userId: ctx.userId,
      name: textDocumentName(trimmed),
      mimeType: "text/plain",
      body: Readable.from([trimmed]),
      source: noteSourceFor(ctx.surface),
    });
    return { reply: duplicateOf ? duplicateReply(document.name) : receivedReply(document.name), citations: [] };
  },
});

const searchWeb = defineCapability({
  name: "searchWeb",
  description:
    "Answer the user's question with a live web search instead of the user's own documents. Use this for anything current or outside what the user has filed, such as today's weather, the news, or a sports score.",
  schema: v.object({ question: v.optional(v.string()) }),
  writes: false,
  destructive: false,
  recordsTurn: true,
  async handler({ question }, ctx) {
    const sessionId = requireSession(ctx);
    const resolvedQuestion = resolveQuestion({ argument: question, userMessage: ctx.userMessage });
    try {
      const { stream, chunks } = await ctx.services.chat.answerFromDocuments({
        userId: ctx.userId,
        sessionId,
        question: resolvedQuestion,
        web: true,
        systemPrompt: withInstructions(ASSISTANT_ANSWERING_SYSTEM_PROMPT, ctx.instructions),
      });
      const text = await drain(stream);
      return { reply: text, citations: parseCitations(text, chunks) };
    } catch (error) {
      if (isAppError(error) && error.code === "ai.web_search_unsupported") {
        return { reply: error.message, citations: [], failed: true };
      }
      throw error;
    }
  },
});

const startNewThread = defineCapability({
  name: "startNewThread",
  description:
    "Clear the current conversation and start a fresh one with no memory of it. Use this only when the user explicitly asks to start over or begin a new conversation.",
  schema: v.object({}),
  writes: false,
  destructive: false,
  recordsTurn: false,
  async handler(_args, ctx) {
    await ctx.startNewThread();
    return { reply: newThreadReply(), citations: [] };
  },
});

const askUser = defineCapability({
  name: "askUser",
  description:
    "Ask the user one short clarifying question instead of guessing. Use this when the user's message is too vague to act on, such as an instruction with no clear subject.",
  schema: v.object({ question: v.string() }),
  writes: false,
  destructive: false,
  recordsTurn: true,
  async handler({ question }) {
    return { reply: ensureQuestionMark(question), citations: [] };
  },
});

const proposeInstruction = defineCapability({
  name: "proposeInstruction",
  description:
    "Offer to add one line to the user's standing instructions, so you handle the same thing their way next time. Use this only after the user has corrected you, and only once per conversation: if they say no, do not offer again.",
  schema: v.object({ line: v.pipe(v.string(), v.minLength(1), v.maxLength(280)) }),
  writes: true,
  destructive: false,
  recordsTurn: true,
  confirm: ({ line }) => `- ${line}\n\nAdd that to your standing instructions?`,
  async handler({ line }, ctx) {
    const updated = appendInstructionLine({ body: ctx.instructions, line });
    await ctx.saveInstructions(updated);
    return { reply: instructionAddedReply(), citations: [] };
  },
});

// The second writing capability, landing with the confirmation state machine rather
// than before it: a write with no way to hold it until a yes had nowhere safe to run
// (assistant confirmation plan, Decision 9). Its handler must never reach the settings
// service on its own: ctx.saveInstructions is the assistant's own saveInstructions,
// bound to this turn's user, so the append goes through the same cap and version
// history an edit from Settings would.
export const assistantCapabilities = {
  answerFromDocuments,
  saveNote,
  searchWeb,
  startNewThread,
  askUser,
  proposeInstruction,
} satisfies Record<string, Capability>;
