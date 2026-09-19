import { Readable } from "node:stream";
import * as v from "valibot";
import type { GenericSchema } from "valibot";
import { isAppError } from "../../shared/errors/errors.js";
import { parseCitations } from "../chat/chat.models.js";
import {
  duplicateReply,
  ensureQuestionMark,
  missingNoteTextReply,
  newThreadReply,
  noteSourceFor,
  receivedReply,
  requireSession,
  resolveQuestion,
  textDocumentName,
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
    const { stream, chunks } = await ctx.services.chat.answerFromDocuments({ userId: ctx.userId, sessionId, question: resolvedQuestion });
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

// proposeInstruction is deliberately absent: it needs the instructions document from
// plan 4, and the registry gains it then as one more record, which is the whole point
// of building this as data rather than as a chain of name checks.
export const assistantCapabilities = {
  answerFromDocuments,
  saveNote,
  searchWeb,
  startNewThread,
  askUser,
} satisfies Record<string, Capability>;
