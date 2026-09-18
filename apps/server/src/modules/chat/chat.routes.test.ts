import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";

function asyncIterableOf(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeAdapter(): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    streamChat: vi.fn(async () => asyncIterableOf(["Hello", " there."])),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function setup() {
  const adapter = fakeAdapter();
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { cookie, userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
  return { t, cookie, userId };
}

const jsonHeaders = (cookie: string) => ({ cookie, "content-type": "application/json" });

describe("chat routes", () => {
  it("requires a session on every route", async () => {
    const { app } = await createTestApp();
    const jsonBody = { "content-type": "application/json" };
    expect((await app.request("/api/chat/sessions", { method: "POST", headers: jsonBody, body: JSON.stringify({}) })).status).toBe(401);
    expect((await app.request("/api/chat/sessions")).status).toBe(401);
    expect((await app.request("/api/chat/sessions/sess_0000000000000000")).status).toBe(401);
    expect((await app.request("/api/chat/sessions/sess_0000000000000000", { method: "DELETE" })).status).toBe(401);
    expect(
      (
        await app.request("/api/chat/sessions/sess_0000000000000000/messages", {
          method: "POST",
          headers: jsonBody,
          body: JSON.stringify({ content: "Hello" }),
        })
      ).status,
    ).toBe(401);
  });

  it("creates, lists, fetches, and deletes a session over HTTP", async () => {
    const { t, cookie } = await setup();

    const createRes = await t.app.request("/api/chat/sessions", { method: "POST", headers: jsonHeaders(cookie), body: JSON.stringify({}) });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { session: { id: string; title: string | null } };
    expect(created.session.title).toBeNull();

    const listRes = await t.app.request("/api/chat/sessions", { headers: { cookie } });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { sessions: { id: string }[] };
    expect(list.sessions.map((s) => s.id)).toContain(created.session.id);

    const getRes = await t.app.request(`/api/chat/sessions/${created.session.id}`, { headers: { cookie } });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { session: { id: string }; messages: unknown[] };
    expect(fetched.session.id).toBe(created.session.id);
    expect(fetched.messages).toEqual([]);

    const deleteRes = await t.app.request(`/api/chat/sessions/${created.session.id}`, { method: "DELETE", headers: { cookie } });
    expect(deleteRes.status).toBe(204);

    const afterDelete = await t.app.request(`/api/chat/sessions/${created.session.id}`, { headers: { cookie } });
    expect(afterDelete.status).toBe(404);
  });

  it("returns 400 for an invalid session id", async () => {
    const { t, cookie } = await setup();
    const res = await t.app.request("/api/chat/sessions/not-a-valid-id", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("streams a message reply over SSE", async () => {
    const { t, cookie } = await setup();
    const createRes = await t.app.request("/api/chat/sessions", { method: "POST", headers: jsonHeaders(cookie), body: JSON.stringify({}) });
    const { session } = (await createRes.json()) as { session: { id: string } };

    const res = await t.app.request(`/api/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ content: "Hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    const eventBlocks = body.trim().split("\n\n");
    const tokenText = eventBlocks
      .filter((block) => block.startsWith("event: token"))
      .map((block) => block.slice(block.indexOf("data: ") + "data: ".length))
      .join("");
    expect(tokenText).toBe("Hello there.");
    expect(body).toContain("event: done");

    const messagesRes = await t.app.request(`/api/chat/sessions/${session.id}`, { headers: { cookie } });
    const { messages } = (await messagesRes.json()) as { messages: { role: string; content: string }[] };
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Hello there." });
  });

  it("rejects a message body that is too long", async () => {
    const { t, cookie } = await setup();
    const createRes = await t.app.request("/api/chat/sessions", { method: "POST", headers: jsonHeaders(cookie), body: JSON.stringify({}) });
    const { session } = (await createRes.json()) as { session: { id: string } };

    const res = await t.app.request(`/api/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ content: "x".repeat(10001) }),
    });
    expect(res.status).toBe(400);
  });
});
