import * as v from "valibot";
import { createError, isAppError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { buildModelUri } from "../ai/ai.models.js";
import type { AiService } from "../ai/ai.usecases.js";
import type { ChatMessage, ChatStreamPart, ToolDefinition } from "../ai/ai.types.js";
import { MAX_HISTORY_MESSAGES } from "../chat/chat.models.js";
import type { ChatService } from "../chat/chat.usecases.js";
import type { Citation } from "../chat/chat.types.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import {
  assertInstructionsWithinCap,
  assistantTroubleReply,
  buildAssistantPrompt,
  commandTurnText,
  DEFAULT_INSTRUCTIONS,
  MAX_INSTRUCTIONS_CHARS,
  pushInstructionVersion,
  toolsUnsupportedNotice,
  WARN_INSTRUCTIONS_CHARS,
} from "./assistant.models.js";
import { assistantCapabilities } from "./assistant.registry.js";
import { INSTRUCTIONS_HISTORY_KEY, INSTRUCTIONS_KEY, TOOLS_UNSUPPORTED_NOTICE_FOR_KEY } from "./assistant.settings.js";
import type { AssistantSurface, Capability, InstructionsView, InstructionVersion, ToolContext, ToolResult } from "./assistant.types.js";

type TurnResult = { reply: string; citations: Citation[]; toolUsed: string | null };

function toToolDefinition(capability: Capability): ToolDefinition {
  return { name: capability.name, description: capability.description, schema: capability.schema };
}

// Parses a command's own arguments against the capability's own schema before the
// handler ever sees them. This is the same boundary driveToolCallStream (ai.usecases.ts)
// enforces on the model's path; skipping it here would mean one handler with two
// behaviors, a transform applied on one path and not the other.
function parseCommandArgs(capability: Capability, args: unknown): unknown {
  const parsed = v.safeParse(capability.schema, args);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    throw createError({
      code: "assistant.invalid_arguments",
      message: `Arguments for "${capability.name}" do not match its schema: ${issue?.message ?? "invalid"}`,
      status: 400,
    });
  }
  return parsed.output;
}

export function createAssistantService({
  chatService,
  documentsService,
  aiService,
  settingsService,
  capabilities = assistantCapabilities,
  // Plan 3 flips this to true once chat_sessions.pending_tool_call exists. Until then
  // no writing tool is offered to the model at all (Decision 1 in the assistant triage
  // plan): a slash command can still run saveNote's handler directly, since typing the
  // command is itself the confirmation.
  allowWritingTools = false,
  logger = createLogger("assistant"),
}: {
  chatService: ChatService;
  documentsService: DocumentsService;
  aiService: AiService;
  settingsService: SettingsService;
  capabilities?: Record<string, Capability>;
  allowWritingTools?: boolean;
  logger?: Logger;
}) {
  const offeredCapabilities = Object.values(capabilities).filter((capability) => !capability.writes || allowWritingTools);
  const offeredToolSpecs = offeredCapabilities.map(toToolDefinition);

  // Resolves the body through getResolved, not the raw get() loadInstructions uses for
  // a turn, so the view can tell the editor whether the user has ever saved at all
  // (assistant instructions plan, Task 1). The history is a second, separate read that
  // defaults to an empty array until the first save ever pushes onto it.
  async function getInstructions({ userId }: { userId: string }): Promise<InstructionsView> {
    const resolved = await settingsService.getResolved(userId, INSTRUCTIONS_KEY);
    const history = (await settingsService.get<InstructionVersion[]>(userId, INSTRUCTIONS_HISTORY_KEY)) ?? [];
    return {
      body: resolved.value as string,
      source: resolved.source,
      maxChars: MAX_INSTRUCTIONS_CHARS,
      warnChars: WARN_INSTRUCTIONS_CHARS,
      shippedDefault: DEFAULT_INSTRUCTIONS,
      history,
    };
  }

  // Trims trailing whitespace, caps, and writes nothing at all when the body is
  // unchanged from what a read returns right now, which on a first save is the shipped
  // default rather than a stored row: comparing against getInstructions's own resolved
  // body, not against a raw stored value, is what keeps a first, unedited save a no-op
  // instead of a default-to-default history entry. The history is written before the
  // body: if the second write fails, the history holds a harmless duplicate of the
  // still-current body rather than losing a version.
  async function saveInstructions({ userId, body }: { userId: string; body: string }): Promise<InstructionsView> {
    const trimmedBody = body.trimEnd();
    assertInstructionsWithinCap(trimmedBody);
    const current = await getInstructions({ userId });
    if (trimmedBody === current.body) return current;

    const history = pushInstructionVersion({ history: current.history, body: current.body, replacedAt: new Date().toISOString() });
    await settingsService.setInternal(userId, INSTRUCTIONS_HISTORY_KEY, history);
    await settingsService.setInternal(userId, INSTRUCTIONS_KEY, trimmedBody);
    return getInstructions({ userId });
  }

  // A restore is a save, not a rewind (Decision 5): it goes through saveInstructions
  // with the found body, so the body it replaces joins the history in exactly the same
  // way an edit from Settings would. Identified by replacedAt, not by index, so the
  // list moving under a save between a read and a restore can never restore the wrong
  // one.
  async function restoreInstructions({ userId, replacedAt }: { userId: string; replacedAt: string }): Promise<InstructionsView> {
    const current = await getInstructions({ userId });
    const version = current.history.find((entry) => entry.replacedAt === replacedAt);
    if (!version) {
      throw createError({
        code: "assistant.instruction_version_not_found",
        message: `No saved version of your instructions was replaced at "${replacedAt}".`,
        status: 404,
      });
    }
    return saveInstructions({ userId, body: version.body });
  }

  // Reads assistant.instructions only, never getInstructions(): a turn has no use for
  // the history array getInstructions also parses, and reading it on every single
  // message is exactly the hot path Decision 4 says stays a map lookup, not a second
  // key's worth of JSON parsing. A read that fails degrades to no instructions rather
  // than a failed turn (Decision 7): logged with the key, never with the body.
  async function loadInstructions(userId: string): Promise<string> {
    try {
      const body = await settingsService.get<string>(userId, INSTRUCTIONS_KEY);
      return body ?? "";
    } catch (error) {
      logger.error(
        { userId, key: INSTRUCTIONS_KEY, err: error instanceof Error ? error.message : String(error) },
        "Failed to load the assistant's instructions for a turn",
      );
      return "";
    }
  }

  async function buildContext({
    userId,
    sessionId,
    surface,
    userMessage,
    startNewThread,
  }: {
    userId: string;
    sessionId: string | null;
    surface: AssistantSurface;
    userMessage: string;
    startNewThread: () => Promise<void>;
  }): Promise<ToolContext> {
    const instructions = await loadInstructions(userId);
    return {
      userId,
      sessionId,
      surface,
      userMessage,
      services: { chat: chatService, documents: documentsService, ai: aiService },
      startNewThread,
      instructions,
    };
  }

  // Runs one capability's handler and never lets a failure escape as a thrown error: an
  // AppError's own message already reads as a sentence a person can act on (the /web on
  // a non-OpenRouter slot case is the existing example), so it is used as is, marked
  // failed so the caller never credits it as a real result. Anything else becomes the
  // generic trouble reply and is logged with the tool's name (Decision 6 in the
  // assistant triage plan).
  //
  // chat.session_not_found is the one exception: it is not a sentence a user can act
  // on, and it means the surface's own idea of the current conversation is wrong, not
  // that the tool failed. It is left to escape here rather than caught into a reply, so
  // whichever surface called runTurn or runCommand sees it and can recover, the way
  // Telegram already retries once on a fresh session (handleAssistantTurn,
  // telegram.usecases.ts). Catching it lower, in a specific surface only, would leave
  // every other caller of a capability free to swallow it again by accident.
  async function runHandler({ name, args, ctx }: { name: string; args: unknown; ctx: ToolContext }): Promise<ToolResult> {
    try {
      const capability = capabilities[name];
      if (!capability) {
        throw createError({ code: "assistant.unknown_tool", message: `Unknown tool "${name}"`, status: 500 });
      }
      return await capability.handler(args, ctx);
    } catch (error) {
      if (isAppError(error) && error.code === "chat.session_not_found") throw error;
      if (isAppError(error)) return { reply: error.message, citations: [], failed: true };
      logger.error({ tool: name, err: error instanceof Error ? error.message : String(error) }, "Assistant tool handler failed");
      return { reply: assistantTroubleReply(), citations: [], failed: true };
    }
  }

  // Said once per configured chat model uri, not once ever and not on every turn
  // (Decision 9). Returns null once there is nothing new to say, either because the
  // model uri cannot be resolved at all or because this exact model already got it.
  async function toolsUnsupportedNoticeIfDue(userId: string): Promise<string | null> {
    let modelUri: string;
    try {
      const { providerId, model } = await aiService.resolveSlot(userId, "chat");
      modelUri = buildModelUri(providerId, model);
    } catch {
      return null;
    }
    const lastNoticedFor = (await settingsService.get<string>(userId, TOOLS_UNSUPPORTED_NOTICE_FOR_KEY)) ?? "";
    if (lastNoticedFor === modelUri) return null;
    await settingsService.setInternal(userId, TOOLS_UNSUPPORTED_NOTICE_FOR_KEY, modelUri);
    return toolsUnsupportedNotice();
  }

  // The fallback for a chat slot that cannot be offered tools at all, whether that was
  // known before the call (supportsTools false) or found out only once the call itself
  // rejected it (ai.tools_unsupported, behavior step 8). Runs answerFromDocuments
  // directly, since with no triage at all it is the one capability that still makes
  // sense of a plain message.
  async function answerWithoutTools({ ctx, userId, sessionId }: { ctx: ToolContext; userId: string; sessionId: string }): Promise<TurnResult> {
    const notice = await toolsUnsupportedNoticeIfDue(userId);
    const result = await runHandler({ name: "answerFromDocuments", args: { question: undefined }, ctx });
    const reply = notice ? `${notice}\n\n${result.reply}` : result.reply;
    await chatService.appendAssistantMessage({ userId, sessionId, content: reply, citations: result.citations });
    return { reply, citations: result.citations, toolUsed: "answerFromDocuments" };
  }

  async function runTurn({
    userId,
    sessionId,
    surface,
    text,
    basePrompt,
    startNewThread,
  }: {
    userId: string;
    sessionId: string;
    surface: AssistantSurface;
    text: string;
    basePrompt: string;
    startNewThread: () => Promise<void>;
  }): Promise<TurnResult> {
    // Appended first, so the model's history includes this turn's own question and the
    // app's chat page shows it even if everything after this fails (behavior step 1).
    await chatService.appendUserMessage({ userId, sessionId, content: text });
    const ctx = await buildContext({ userId, sessionId, surface, userMessage: text, startNewThread });

    try {
      const canUseTools = await aiService.supportsTools(userId);
      if (!canUseTools) return await answerWithoutTools({ ctx, userId, sessionId });

      const priorMessages = await chatService.listMessages({ userId, sessionId });
      const history: ChatMessage[] = priorMessages.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
      // No retrieved chunks here (Decision 2): retrieval lives inside
      // answerFromDocuments's own handler, so the call that can emit a tool call never
      // sees document text, only the system prompt, the conversation so far, and the
      // user's own instructions, appended last (Decision 6 in the assistant
      // instructions plan).
      const prompt = buildAssistantPrompt({
        basePrompt,
        tools: offeredToolSpecs,
        writesWithheld: !allowWritingTools,
        instructions: ctx.instructions,
      });
      const messages: ChatMessage[] = [{ role: "system", content: prompt }, ...history];

      let stream: AsyncIterable<ChatStreamPart>;
      try {
        stream = await aiService.streamChatWithTools({ userId, messages, tools: offeredToolSpecs });
      } catch (error) {
        // The model changed under us between the capability check above and this call:
        // fall back rather than fail the turn (behavior step 8).
        if (isAppError(error) && error.code === "ai.tools_unsupported") return await answerWithoutTools({ ctx, userId, sessionId });
        throw error;
      }

      let accumulatedText = "";
      let chosenCall: { id: string; name: string; arguments: unknown } | null = null;
      for await (const part of stream) {
        if (part.type === "text") {
          accumulatedText += part.text;
          continue;
        }
        // One tool call per turn: the first one wins, a second is logged and ignored
        // (Decision 5). Text written before the winning call is dropped below, never
        // prefixed to the handler's reply, since it is written before the tool has run.
        if (chosenCall) {
          logger.warn({ tool: part.name, sessionId }, "Assistant model called a second tool in the same turn, ignoring it");
          continue;
        }
        chosenCall = part;
      }

      if (!chosenCall) {
        const reply = accumulatedText.trim().length > 0 ? accumulatedText : assistantTroubleReply();
        await chatService.appendAssistantMessage({ userId, sessionId, content: reply });
        return { reply, citations: [], toolUsed: null };
      }

      // chosenCall.arguments was already validated against the tool's own schema inside
      // driveToolCallStream (ai.usecases.ts), so it is not re-parsed here. runCommand,
      // which never touches the AI layer, validates on its own path below instead.
      const result = await runHandler({ name: chosenCall.name, args: chosenCall.arguments, ctx });
      await chatService.appendAssistantMessage({ userId, sessionId, content: result.reply, citations: result.citations });
      // A handler that answered from its own failure path did not do the job the tool
      // names, so it is not reported as used. Otherwise a surface reading toolUsed
      // appends a success footer to a message explaining the tool could not run.
      return { reply: result.reply, citations: result.citations, toolUsed: result.failed ? null : chosenCall.name };
    } catch (error) {
      // Anything that escapes the paths above, such as the model call itself failing
      // outright, still gets a saved assistant turn: a user turn left unanswered would
      // also break role alternation on the next turn (Decision 6).
      const reply = isAppError(error) ? error.message : assistantTroubleReply();
      if (!isAppError(error)) {
        logger.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "Assistant turn failed unexpectedly");
      }
      await chatService.appendAssistantMessage({ userId, sessionId, content: reply });
      return { reply, citations: [], toolUsed: null };
    }
  }

  async function runCommand({
    userId,
    sessionId,
    surface,
    tool,
    args,
    startNewThread,
  }: {
    userId: string;
    sessionId: string | null;
    surface: AssistantSurface;
    tool: string;
    args: unknown;
    startNewThread: () => Promise<void>;
  }): Promise<{ reply: string; citations: Citation[]; toolUsed: string | null }> {
    const capability = capabilities[tool];
    if (!capability) {
      throw createError({ code: "assistant.unknown_tool", message: `Unknown tool "${tool}"`, status: 400 });
    }
    // No triage and no model call: a slash command is an exact instruction, so it goes
    // straight to the handler once its own arguments check out.
    const parsedArgs = parseCommandArgs(capability, args);
    const ctx = await buildContext({ userId, sessionId, surface, userMessage: "", startNewThread });

    const result = await runHandler({ name: tool, args: parsedArgs, ctx });

    // Read from the capability record, never inferred from whether sessionId happens to
    // be set: a capability that does not record a turn must record nothing even when a
    // real session is given, which matters once plan 5 runs a command inside a session
    // that already exists.
    if (capability.recordsTurn && sessionId) {
      await chatService.appendUserMessage({ userId, sessionId, content: commandTurnText({ tool, args: parsedArgs }) });
      await chatService.appendAssistantMessage({ userId, sessionId, content: result.reply, citations: result.citations });
    }

    // failed means the reply came from the handler's own graceful failure path, not
    // from the tool actually doing its job, so it must not be credited as the tool
    // that answered (Telegram's "Searched the web for this" footer, assistantReplyText
    // in telegram.usecases.ts, reads toolUsed for exactly this).
    return { reply: result.reply, citations: result.citations, toolUsed: result.failed ? null : tool };
  }

  return { runTurn, runCommand, getInstructions, saveInstructions, restoreInstructions };
}

export type AssistantService = ReturnType<typeof createAssistantService>;
