import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseJsonBody, parseOrValidationError } from "../../shared/http/validate.js";
import { createSessionBodySchema, sendMessageBodySchema, sessionIdSchema } from "./chat.schemas.js";
import type { ChatService } from "./chat.usecases.js";

export function registerChatRoutes({
  app,
  chatService,
  getUserId,
}: {
  app: Hono;
  chatService: ChatService;
  getUserId: (c: Context) => string;
}) {
  app.post("/api/chat/sessions", async (c) => {
    const body = await parseJsonBody(c, createSessionBodySchema);
    const session = await chatService.createSession({ userId: getUserId(c), documentScope: body.documentScope });
    return c.json({ session }, 201);
  });

  app.get("/api/chat/sessions", async (c) => {
    const sessions = await chatService.listSessions(getUserId(c));
    return c.json({ sessions });
  });

  app.get("/api/chat/sessions/:id", async (c) => {
    const sessionId = parseOrValidationError(sessionIdSchema, c.req.param("id"));
    const userId = getUserId(c);
    const session = await chatService.getSession({ userId, sessionId });
    const messages = await chatService.listMessages({ userId, sessionId });
    return c.json({ session, messages });
  });

  app.delete("/api/chat/sessions/:id", async (c) => {
    const sessionId = parseOrValidationError(sessionIdSchema, c.req.param("id"));
    await chatService.deleteSession({ userId: getUserId(c), sessionId });
    return c.body(null, 204);
  });

  app.post("/api/chat/sessions/:id/messages", async (c) => {
    const sessionId = parseOrValidationError(sessionIdSchema, c.req.param("id"));
    const { content } = await parseJsonBody(c, sendMessageBodySchema);
    const userId = getUserId(c);
    const generator = await chatService.sendMessage({ userId, sessionId, content });

    return streamSSE(c, async (stream) => {
      for await (const event of generator) {
        if (event.event === "token") {
          await stream.writeSSE({ event: "token", data: event.data });
        } else {
          await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
        }
      }
    });
  });
}
