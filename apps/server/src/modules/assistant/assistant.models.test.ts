import { describe, expect, it } from "vitest";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import type { ToolDefinition } from "../ai/ai.types.js";
import {
  assistantTroubleReply,
  buildAssistantPrompt,
  commandTurnText,
  duplicateReply,
  ensureQuestionMark,
  missingNoteTextReply,
  newThreadReply,
  noteSourceFor,
  receivedReply,
  requireSession,
  resolveQuestion,
  textDocumentName,
  toolsUnsupportedNotice,
} from "./assistant.models.js";

describe("assistant models", () => {
  it("titles a text note from its first line, truncated", () => {
    expect(textDocumentName("Remember to renew the lease by Friday.")).toBe("Remember to renew the lease by Friday..txt");
    const long = "x".repeat(80);
    expect(textDocumentName(`${long}\nsecond line`)).toBe(`${long.slice(0, 60)}....txt`);
  });

  it("asks what to note when /note has no text, without naming a document", () => {
    expect(missingNoteTextReply()).toMatch(/\/note/);
  });

  it("says starting fresh when /new resets the conversation", () => {
    expect(newThreadReply()).toMatch(/fresh|new/i);
  });

  it("reads word for word like the telegram intake replies", () => {
    expect(receivedReply("receipt.pdf")).toMatch(/got it/i);
    expect(receivedReply("receipt.pdf")).toContain("receipt.pdf");
    expect(duplicateReply("receipt.pdf")).toMatch(/already/i);
  });

  it("appends a question mark only when the model forgot one", () => {
    expect(ensureQuestionMark("What do you want to call it")).toBe("What do you want to call it?");
    expect(ensureQuestionMark("What do you want to call it?")).toBe("What do you want to call it?");
    expect(ensureQuestionMark("   ")).toBe("?");
  });

  it("files a telegram note under the telegram source, and an app note under upload", () => {
    expect(noteSourceFor("telegram")).toBe("telegram");
    expect(noteSourceFor("app")).toBe("upload");
  });

  it("falls back to the user's own message when the model's argument is missing", () => {
    expect(resolveQuestion({ argument: "the paraphrase", userMessage: "the real question" })).toBe("the paraphrase");
    expect(resolveQuestion({ argument: undefined, userMessage: "the real question" })).toBe("the real question");
    expect(resolveQuestion({ argument: "   ", userMessage: "the real question" })).toBe("the real question");
  });

  it("refuses a session-bound helper with a plain-English error when there is no session", async () => {
    await expectAppError(() => requireSession({ sessionId: null }), "assistant.session_required");
    expect(requireSession({ sessionId: "sess_1" })).toBe("sess_1");
  });

  it("builds a tool-choosing prompt that lists every tool by name and description", () => {
    const tools: ToolDefinition[] = [
      { name: "answerFromDocuments", description: "Answer from the user's own documents.", schema: {} as ToolDefinition["schema"] },
      { name: "startNewThread", description: "Clear the current conversation.", schema: {} as ToolDefinition["schema"] },
    ];

    const prompt = buildAssistantPrompt({ basePrompt: "Base prompt.", tools, writesWithheld: false });

    expect(prompt).toContain("Base prompt.");
    expect(prompt).toContain("answerFromDocuments");
    expect(prompt).toContain("Answer from the user's own documents.");
    expect(prompt).toContain("startNewThread");
    expect(prompt).not.toMatch(/\/note/);
  });

  it("points to /note in the prompt when writes are withheld, and says nothing about it otherwise", () => {
    const tools: ToolDefinition[] = [];
    expect(buildAssistantPrompt({ basePrompt: "Base.", tools, writesWithheld: true })).toMatch(/\/note/);
    expect(buildAssistantPrompt({ basePrompt: "Base.", tools, writesWithheld: false })).not.toMatch(/\/note/);
  });

  it("names Settings in the no-tools notice, since that is where to fix it", () => {
    expect(toolsUnsupportedNotice()).toMatch(/settings/i);
  });

  it("reads differently from telegram's own generic trouble reply", () => {
    expect(assistantTroubleReply()).not.toBe("Something went wrong on my end there. Try sending that again.");
    expect(assistantTroubleReply().length).toBeGreaterThan(0);
  });

  it("labels a recorded command exchange from its own string argument", () => {
    expect(commandTurnText({ tool: "searchWeb", args: { question: "weather today" } })).toBe("weather today");
    expect(commandTurnText({ tool: "startNewThread", args: {} })).toBe("/startNewThread");
    expect(commandTurnText({ tool: "startNewThread", args: undefined })).toBe("/startNewThread");
  });
});
