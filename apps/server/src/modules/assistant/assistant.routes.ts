import type { Context, Hono } from "hono";
import { createError } from "../../shared/errors/errors.js";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { sessionIdSchema } from "../chat/chat.schemas.js";
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
}
