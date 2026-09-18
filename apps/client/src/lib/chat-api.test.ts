import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApi } from "./chat-api";

afterEach(() => vi.restoreAllMocks());

describe("chatApi", () => {
  it("creates a session", async () => {
    const session = { id: "sess_1", title: null, documentScope: null, createdAt: "now", updatedAt: "now" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ session }), { status: 201 }));
    const result = await chatApi.createSession();
    expect(result).toEqual(session);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/chat/sessions");
  });

  it("lists sessions", async () => {
    const sessions = [{ id: "sess_1", title: "Rent question", documentScope: null, createdAt: "now", updatedAt: "now" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sessions }), { status: 200 }));
    const result = await chatApi.listSessions();
    expect(result).toEqual(sessions);
  });

  it("fetches a session with its messages", async () => {
    const session = { id: "sess_1", title: null, documentScope: null, createdAt: "now", updatedAt: "now" };
    const messages = [{ id: "msg_1", sessionId: "sess_1", role: "user", content: "hi", citations: null, error: null, createdAt: "now" }];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ session, messages }), { status: 200 }));
    const result = await chatApi.getSession("sess_1");
    expect(result).toEqual({ session, messages });
    expect(spy.mock.calls[0]?.[0]).toBe("/api/chat/sessions/sess_1");
  });

  it("deletes a session", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await chatApi.deleteSession("sess_1");
    expect(spy.mock.calls[0]?.[0]).toBe("/api/chat/sessions/sess_1");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
