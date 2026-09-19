import type { GenericSchema } from "valibot";
import type { AiService } from "../ai/ai.usecases.js";
import type { ChatService } from "../chat/chat.usecases.js";
import type { Citation } from "../chat/chat.types.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { SettingSource } from "../settings/settings.types.js";

// The surface a turn or a command came through. Telegram is the only one wired to the
// assistant so far (see telegram.usecases.ts); the app's own chat page joins in plan 5.
export type AssistantSurface = "app" | "telegram";

// One entry in the instructions document's history (assistant.usecases.ts,
// pushInstructionVersion). replacedAt, not savedAt: the honest timestamp is the moment
// this body stopped being the live one.
export type InstructionVersion = { body: string; replacedAt: string };

// What GET /api/assistant/instructions and every write on that route return.
// source is "default" until the user's first save, then "db", the same vocabulary
// settings.getResolved already uses.
export type InstructionsView = {
  body: string;
  source: SettingSource;
  maxChars: number;
  warnChars: number;
  history: InstructionVersion[];
};

export type ToolContext = {
  userId: string;
  // Null for a command that has nothing to do with the conversation, such as /note.
  // A handler that needs history or document scope calls requireSession(ctx) and gets
  // a plain-English AppError if there is none (see assistant.models.ts).
  sessionId: string | null;
  surface: AssistantSurface;
  // The user's own message, so a handler can answer the question that was actually
  // asked rather than the model's paraphrase of it when it omits an argument.
  userMessage: string;
  services: { chat: ChatService; documents: DocumentsService; ai: AiService };
  // What the surface does about its own thread pointer. Telegram clears
  // telegram.chatSessionId; the app supplies its own in plan 5.
  startNewThread: () => Promise<void>;
  // The user's standing instructions document, resolved once per turn (loadInstructions,
  // assistant.usecases.ts). Empty string when nothing was saved yet would be wrong: the
  // shipped default is what a turn sends until the user's first save, and only a read
  // failure resolves to "".
  instructions: string;
};

// failed marks a reply that came from a handler's own graceful failure path rather
// than the tool actually doing its job, such as searchWeb's own plain-English answer
// when the chat model has no web search (assistant.registry.ts). Left unset on a real
// result. runCommand reads it to decide whether toolUsed should name the tool at all
// (assistant.usecases.ts), so a failure never gets credited as a success downstream.
export type ToolResult = { reply: string; citations: Citation[]; failed?: boolean };

export type Capability = {
  name: string;
  description: string; // the text the model reads, and the whole of triage quality
  schema: GenericSchema; // arguments, validated by the AI layer before the handler runs
  writes: boolean;
  destructive: boolean;
  recordsTurn: boolean; // whether a slash command's exchange joins the conversation
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
};
