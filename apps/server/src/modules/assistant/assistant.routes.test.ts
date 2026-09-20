import { describe, expect, it, vi } from "vitest";
import { chatStreamPartsOf, fakeAdapter } from "../../shared/test/ai.test-utils.js";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import type { ChatStreamPart } from "../ai/ai.types.js";
import { DEFAULT_INSTRUCTIONS, MAX_INSTRUCTIONS_CHARS, WARN_INSTRUCTIONS_CHARS } from "./assistant.models.js";

async function setup() {
  const t = await createTestApp();
  const { cookie, userId } = await t.signIn();
  return { t, cookie, userId };
}

const jsonHeaders = (cookie: string) => ({ cookie, "content-type": "application/json" });

function toolCallStream(name: string, args: unknown): AsyncIterable<ChatStreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "toolCall", id: "call_1", name, arguments: args };
    },
  };
}

const BASE_PROMPT = "You are a helpful assistant for testing.";

// A session with a saveNote proposal already waiting on it, made through runTurn the
// same way the model would trigger one, so the route test exercises the real column
// rather than one it wrote itself.
async function setupWithProposal(noteText = "buy milk before the shop closes") {
  const adapter = fakeAdapter({ streamChat: vi.fn(async () => toolCallStream("saveNote", { text: noteText })) });
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { cookie, userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
  const session = await t.services.chatService.createSession({ userId });
  const turn = await t.services.assistantService.runTurn({
    userId,
    sessionId: session.id,
    surface: "telegram",
    text: "note buy milk before the shop closes",
    basePrompt: BASE_PROMPT,
    startNewThread: vi.fn(async () => {}),
  });
  return { t, cookie, userId, sessionId: session.id, proposal: turn.proposal! };
}

describe("assistant instructions routes", () => {
  it("rejects an unauthenticated request", async () => {
    const { app } = await createTestApp();
    const jsonBody = { "content-type": "application/json" };

    expect((await app.request("/api/assistant/instructions")).status).toBe(401);
    expect(
      (await app.request("/api/assistant/instructions", { method: "PUT", headers: jsonBody, body: JSON.stringify({ body: "hi" }) })).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/assistant/instructions/restore", {
          method: "POST",
          headers: jsonBody,
          body: JSON.stringify({ replacedAt: "2026-09-19T00:00:00.000Z" }),
        })
      ).status,
    ).toBe(401);
  });

  it("returns the shipped default, the caps and an empty history", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions", { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe(DEFAULT_INSTRUCTIONS);
    expect(body.source).toBe("default");
    expect(body.maxChars).toBe(MAX_INSTRUCTIONS_CHARS);
    expect(body.warnChars).toBe(WARN_INSTRUCTIONS_CHARS);
    expect(body.shippedDefault).toBe(DEFAULT_INSTRUCTIONS);
    expect(body.history).toEqual([]);
  });

  it("saves a document and returns the new view with the old one in the history", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ body: "Keep replies short." }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("Keep replies short.");
    expect(body.source).toBe("db");
    expect(body.shippedDefault).toBe(DEFAULT_INSTRUCTIONS);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].body).toBe(DEFAULT_INSTRUCTIONS);
  });

  it("refuses a document over the cap with 400 and a sentence naming the limit", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ body: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) }),
    });

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe("assistant.instructions_too_long");
    expect(payload.error.message).toContain(String(MAX_INSTRUCTIONS_CHARS));
  });

  it("restores a version by its timestamp", async () => {
    const { t, cookie } = await setup();
    await t.app.request("/api/assistant/instructions", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ body: "First version." }),
    });
    const afterSecondSave = await (
      await t.app.request("/api/assistant/instructions", {
        method: "PUT",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ body: "Second version." }),
      })
    ).json();
    const firstVersion = afterSecondSave.history.find((v: { body: string }) => v.body === "First version.");
    expect(firstVersion).toBeDefined();

    const res = await t.app.request("/api/assistant/instructions/restore", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ replacedAt: firstVersion.replacedAt }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("First version.");
    expect(body.history.some((v: { body: string }) => v.body === "Second version.")).toBe(true);
  });

  it("returns 404 for a version that is not in the history", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions/restore", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ replacedAt: "2020-01-01T00:00:00.000Z" }),
    });

    expect(res.status).toBe(404);
    const payload = await res.json();
    expect(payload.error.code).toBe("assistant.instruction_version_not_found");
  });

  it("refuses to write the document through the settings API", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/settings", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ updates: { "assistant.instructions": "Sneaking in." } }),
    });

    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.error.code).toBe("settings.internal_only");
  });

  it("does not list the document in GET /api/settings", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/settings", { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.some((s: { key: string }) => s.key === "assistant.instructions")).toBe(false);
    expect(body.settings.some((s: { key: string }) => s.key === "assistant.instructionsHistory")).toBe(false);
  });
});

describe("assistant proposal routes", () => {
  it("returns nothing when no proposal is waiting", async () => {
    const { t, cookie, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });

    const res = await t.app.request(`/api/assistant/sessions/${session.id}/proposal`, { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal).toBeNull();
  });

  it("returns the waiting proposal with the exact sentence the user was shown", async () => {
    const { t, cookie, sessionId, proposal } = await setupWithProposal();

    const res = await t.app.request(`/api/assistant/sessions/${sessionId}/proposal`, { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal.id).toBe(proposal.id);
    expect(body.proposal.tool).toBe("saveNote");
    expect(body.proposal.text).toBe(proposal.text);
    expect(body.proposal.messageId).toBe(proposal.messageId);
  });

  it("never returns the stored arguments", async () => {
    const { t, cookie, sessionId } = await setupWithProposal();

    const res = await t.app.request(`/api/assistant/sessions/${sessionId}/proposal`, { headers: { cookie } });

    const body = await res.json();
    expect(body.proposal.args).toBeUndefined();
  });

  it("runs the proposal on yes and returns the reply", async () => {
    const { t, cookie, userId, sessionId, proposal } = await setupWithProposal();

    const res = await t.app.request(`/api/assistant/sessions/${sessionId}/proposal/answer`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ proposalId: proposal.id, decision: "yes" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ran");
    expect(typeof body.reply).toBe("string");
    const documents = await t.services.documentsService.list({ userId });
    expect(documents).toHaveLength(1);
  });

  it("discards it on no", async () => {
    const { t, cookie, userId, sessionId, proposal } = await setupWithProposal();

    const res = await t.app.request(`/api/assistant/sessions/${sessionId}/proposal/answer`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ proposalId: proposal.id, decision: "no" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("declined");
    const documents = await t.services.documentsService.list({ userId });
    expect(documents).toHaveLength(0);
  });

  it("returns stale for an id that is not the waiting one", async () => {
    const { t, cookie, sessionId } = await setupWithProposal();

    const res = await t.app.request(`/api/assistant/sessions/${sessionId}/proposal/answer`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ proposalId: "prop_not_the_one", decision: "yes" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("stale");
  });

  it("rejects an unauthenticated request", async () => {
    const { t, sessionId, proposal } = await setupWithProposal();
    const jsonBody = { "content-type": "application/json" };

    expect((await t.app.request(`/api/assistant/sessions/${sessionId}/proposal`)).status).toBe(401);
    expect(
      (
        await t.app.request(`/api/assistant/sessions/${sessionId}/proposal/answer`, {
          method: "POST",
          headers: jsonBody,
          body: JSON.stringify({ proposalId: proposal.id, decision: "yes" }),
        })
      ).status,
    ).toBe(401);
  });

  it("returns 404 for a session that is not the user's", async () => {
    // DocMind is single-account, so there is no second sign-up to authenticate as. The
    // ownership check is the chat service's own, keyed on userId with no foreign key to
    // the auth tables (chat.usecases.test.ts proves the same thing at that layer with a
    // synthetic id), so a session owned by an id other than the signed-in cookie's is
    // enough to exercise it here too.
    const adapter = fakeAdapter({ streamChat: vi.fn(async () => toolCallStream("saveNote", { text: "buy milk" })) });
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
    const { cookie } = await t.signIn();
    const otherUserId = "user_other";
    const session = await t.services.chatService.createSession({ userId: otherUserId });
    await t.services.settingsService.set(otherUserId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://test-chat-model",
    });
    const turn = await t.services.assistantService.runTurn({
      userId: otherUserId,
      sessionId: session.id,
      surface: "telegram",
      text: "note buy milk",
      basePrompt: BASE_PROMPT,
      startNewThread: vi.fn(async () => {}),
    });

    const getRes = await t.app.request(`/api/assistant/sessions/${session.id}/proposal`, { headers: { cookie } });
    expect(getRes.status).toBe(404);

    const postRes = await t.app.request(`/api/assistant/sessions/${session.id}/proposal/answer`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ proposalId: turn.proposal!.id, decision: "yes" }),
    });
    expect(postRes.status).toBe(404);
  });

  it("rejects a decision that is neither yes nor no", async () => {
    const { t, cookie, sessionId, proposal } = await setupWithProposal();

    const res = await t.app.request(`/api/assistant/sessions/${sessionId}/proposal/answer`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ proposalId: proposal.id, decision: "maybe" }),
    });

    expect(res.status).toBe(400);
  });
});

// Splits an SSE response body into its blocks and finds the one with the given event
// name, the same shape chat.routes.test.ts already asserts on for the sibling route.
function findEventBlock(body: string, event: string): string | undefined {
  return body
    .trim()
    .split("\n\n")
    .find((block) => block.startsWith(`event: ${event}`));
}

function dataOf(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""))
    .join("\n");
}

describe("assistant app chat route", () => {
  it("rejects an unauthenticated request", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/assistant/sessions/sess_0000000000000000/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    });
    expect(res.status).toBe(401);
  });

  // The app's own chat page now runs a turn through the same assistant path Telegram
  // does (plan 5, ruling 1): one token event carrying the whole reply, since runTurn
  // returns a single Promise<TurnResult> with nothing left to stream piece by piece,
  // then a done event with the citations, exactly like chat.routes.ts's own sendMessage
  // route already sends for the lower-level RAG path.
  it("streams the full reply as one token event, then done, for an ordinary turn", async () => {
    const adapter = fakeAdapter({ streamChat: vi.fn(async () => chatStreamPartsOf(["Rent is due on the first."])) });
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
    const { cookie, userId } = await t.signIn();
    await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
    const session = await t.services.chatService.createSession({ userId });

    const res = await t.app.request(`/api/assistant/sessions/${session.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ content: "When is rent due?" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();

    const tokenBlock = findEventBlock(body, "token");
    expect(tokenBlock).toBeDefined();
    expect(dataOf(tokenBlock!)).toBe("Rent is due on the first.");

    const doneBlock = findEventBlock(body, "done");
    expect(doneBlock).toBeDefined();
    expect(findEventBlock(body, "proposal")).toBeUndefined();

    const messagesRes = await t.app.request(`/api/chat/sessions/${session.id}`, { headers: { cookie } });
    const { messages } = (await messagesRes.json()) as { messages: { role: string; content: string }[] };
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Rent is due on the first." });
  });

  // A write capability's own confirmation sentence (assistant confirmation plan) comes
  // back as a proposal event instead of done, and the pending proposal it names is the
  // exact same one GET .../proposal already exposes, so a client reading either one
  // sees the same offer.
  it("emits a proposal event instead of done when the turn makes one", async () => {
    const adapter = fakeAdapter({ streamChat: vi.fn(async () => toolCallStream("saveNote", { text: "buy milk before the shop closes" })) });
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
    const { cookie, userId } = await t.signIn();
    await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
    const session = await t.services.chatService.createSession({ userId });

    const res = await t.app.request(`/api/assistant/sessions/${session.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ content: "note buy milk before the shop closes" }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(findEventBlock(body, "done")).toBeUndefined();
    const proposalBlock = findEventBlock(body, "proposal");
    expect(proposalBlock).toBeDefined();
    const payload = JSON.parse(dataOf(proposalBlock!)) as { id: string; tool: string };
    expect(payload.tool).toBe("saveNote");

    const proposalRes = await t.app.request(`/api/assistant/sessions/${session.id}/proposal`, { headers: { cookie } });
    const proposalBody = (await proposalRes.json()) as { proposal: { id: string } | null };
    expect(proposalBody.proposal?.id).toBe(payload.id);
  });

  it("returns 404 for a session that is not the user's", async () => {
    const t = await createTestApp();
    const { cookie } = await t.signIn();
    const otherSession = await t.services.chatService.createSession({ userId: "user_other" });

    const res = await t.app.request(`/api/assistant/sessions/${otherSession.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ content: "hi" }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a message body that is too long", async () => {
    const { t, cookie, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });

    const res = await t.app.request(`/api/assistant/sessions/${session.id}/messages`, {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ content: "x".repeat(10001) }),
    });

    expect(res.status).toBe(400);
  });
});
