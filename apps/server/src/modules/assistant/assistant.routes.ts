import type { Context, Hono } from "hono";
import { parseJsonBody } from "../../shared/http/validate.js";
import { restoreInstructionsBodySchema, saveInstructionsBodySchema } from "./assistant.schemas.js";
import type { AssistantService } from "./assistant.usecases.js";

// Three thin handlers over the instructions usecases, the same shape as
// telegram.routes.ts: routes parse input and read the user id, the service does
// everything else, including the cap and the versioning.
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
}
