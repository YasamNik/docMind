import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createError } from "../../shared/errors/errors.js";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { sendMessageBodySchema, sessionIdSchema } from "../chat/chat.schemas.js";
import { ASSISTANT_TRIAGE_SYSTEM_PROMPT } from "./assistant.models.js";
import { answerProposalBodySchema, restoreInstructionsBodySchema, saveInstructionsBodySchema } from "./assistant.schemas.js";
import type { AssistantService } from "./assistant.usecases.js";

// Thin handlers over the instructions and proposal usecases, the same shape as
// telegram.routes.ts: routes parse input and read the user id, the service does
// everything else, including the cap and the versioning, and, for a proposal, the
// claim that makes it answerable only once (assistant confirmation plan, Task 4).
export function registerAssistantRoutes({
  app,
  assistantService,
  getUserId,
}: {
  app: Hono;
  assistantService: AssistantService;
  getUserId: (c: Context) => string;
}) {
  app.get("/api/assistant/instructions", async (c) => {
    const view = await assistantService.getInstructions({ userId: getUserId(c) });
    return c.json(view);
  });

  app.put("/api/assistant/instructions", async (c) => {
    const userId = getUserId(c);
    const { body } = await parseJsonBody(c, saveInstructionsBodySchema);
    const view = await assistantService.saveInstructions({ userId, body });
    return c.json(view);
  });

  app.post("/api/assistant/instructions/restore", async (c) => {
    const userId = getUserId(c);
    const { replacedAt } = await parseJsonBody(c, restoreInstructionsBodySchema);
    const view = await assistantService.restoreInstructions({ userId, replacedAt });
    return c.json(view);
  });

  // Ownership needs no check of its own: getPendingProposal resolves the session
  // through the chat service, which rejects another user's session with
  // chat.session_not_found, turned into a 404 by the shared error handler. A session
  // with nothing waiting is not an error: it reads as { proposal: null }, the same
  // null a stored value that fails to parse also degrades to, so this route never 500s
  // on a row it cannot make sense of.
  app.get("/api/assistant/sessions/:sessionId/proposal", async (c) => {
    const sessionId = parseOrValidationError(sessionIdSchema, c.req.param("sessionId"));
    const proposal = await assistantService.getPendingProposal({ userId: getUserId(c), sessionId });
    return c.json({ proposal });
  });

  // startNewThread is the one argument the app cannot supply yet: no capability that
  // can be confirmed calls it (startNewThread itself neither writes nor deletes), but
  // answerProposal's own signature takes the callback regardless. A callback that
  // throws a plain-English error if it is ever reached is safer than a silent no-op,
  // which would look like the feature works until someone notices it did nothing.
  app.post("/api/assistant/sessions/:sessionId/proposal/answer", async (c) => {
    const sessionId = parseOrValidationError(sessionIdSchema, c.req.param("sessionId"));
    const userId = getUserId(c);
    const { proposalId, decision } = await parseJsonBody(c, answerProposalBodySchema);
    const result = await assistantService.answerProposal({
      userId,
      sessionId,
      proposalId,
      decision,
      surface: "app",
      startNewThread: async () => {
        throw createError({
          code: "assistant.thread_reset_unavailable",
          message: "Starting a new thread from the app is not available yet.",
          status: 501,
        });
      },
    });
    return c.json(result);
  });

  // The app's own chat page onto the same path Telegram's turns already run through
  // (assistant plan 5, ruling 1): runTurn returns one Promise<TurnResult>, with both
  // answering handlers (assistant.registry.ts) already draining their own RAG stream
  // into a single string before it gets here, so there is no partial text to stream out
  // token by token. The reply is sent as one token event carrying the full text, so the
  // client's existing SSE parse loop needs no new event name, only a new one to handle:
  // a session with a proposal waiting gets a proposal event instead of done, carrying
  // the same PendingProposal shape GET .../proposal already returns.
  app.post("/api/assistant/sessions/:sessionId/messages", async (c) => {
    const sessionId = parseOrValidationError(sessionIdSchema, c.req.param("sessionId"));
    const userId = getUserId(c);
    const { content } = await parseJsonBody(c, sendMessageBodySchema);

    // Awaited before the SSE response opens, exactly like chat.routes.ts awaits
    // chatService.sendMessage: a bad or foreign sessionId throws chat.session_not_found
    // here and is turned into a plain 404 by the shared error handler, rather than
    // surfacing as an error event inside a 200 stream.
    const result = await assistantService.runTurn({
      userId,
      sessionId,
      surface: "app",
      text: content,
      basePrompt: ASSISTANT_TRIAGE_SYSTEM_PROMPT,
      startNewThread: async () => {
        throw createError({
          code: "assistant.thread_reset_unavailable",
          message: "Starting a new thread from the app is not available yet.",
          status: 501,
        });
      },
    });

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "token", data: result.reply });
      if (result.proposal) {
        await stream.writeSSE({ event: "proposal", data: JSON.stringify(result.proposal) });
      } else {
        await stream.writeSSE({ event: "done", data: JSON.stringify({ citations: result.citations }) });
      }
    });
  });
}
