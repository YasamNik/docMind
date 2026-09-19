import { describe, expect, it } from "vitest";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import type { ToolDefinition } from "../ai/ai.types.js";
import type { InstructionVersion } from "./assistant.types.js";
import {
  assertInstructionsWithinCap,
  assistantTroubleReply,
  buildAssistantPrompt,
  commandTurnText,
  DEFAULT_INSTRUCTIONS,
  duplicateReply,
  ensureQuestionMark,
  instructionsSection,
  MAX_INSTRUCTION_VERSIONS,
  MAX_INSTRUCTIONS_CHARS,
  missingNoteTextReply,
  newThreadReply,
  noteSourceFor,
  pushInstructionVersion,
  receivedReply,
  requireSession,
  resolveQuestion,
  textDocumentName,
  toolsUnsupportedNotice,
  WARN_INSTRUCTIONS_CHARS,
  withInstructions,
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

describe("assistant models, the instructions document", () => {
  it("ships a default document with headings a person can edit", () => {
    expect(DEFAULT_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(DEFAULT_INSTRUCTIONS).toMatch(/^# /m);
    expect(DEFAULT_INSTRUCTIONS).toMatch(/^## /m);
  });

  it("ships a default well under the warning threshold", () => {
    expect(DEFAULT_INSTRUCTIONS.length).toBeLessThan(WARN_INSTRUCTIONS_CHARS);
  });

  it("accepts a document of exactly the maximum length", () => {
    expect(() => assertInstructionsWithinCap("x".repeat(MAX_INSTRUCTIONS_CHARS))).not.toThrow();
  });

  it("refuses one character over, and says the size and the limit", async () => {
    const oneOver = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);
    await expectAppError(() => {
      assertInstructionsWithinCap(oneOver);
    }, "assistant.instructions_too_long");
    try {
      assertInstructionsWithinCap(oneOver);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(String(oneOver.length));
      expect(message).toContain(String(MAX_INSTRUCTIONS_CHARS));
    }
  });

  it("pushes the previous body onto the front of the history", () => {
    const history = pushInstructionVersion({ history: [], body: "old text", replacedAt: "2026-09-19T00:00:00.000Z" });
    expect(history).toEqual([{ body: "old text", replacedAt: "2026-09-19T00:00:00.000Z" }]);
  });

  it("records when each version stopped being the live one", () => {
    const afterFirst = pushInstructionVersion({ history: [], body: "first", replacedAt: "2026-09-19T00:00:00.000Z" });
    const afterSecond = pushInstructionVersion({ history: afterFirst, body: "second", replacedAt: "2026-09-19T01:00:00.000Z" });
    expect(afterSecond[0]).toEqual({ body: "second", replacedAt: "2026-09-19T01:00:00.000Z" });
    expect(afterSecond[1]).toEqual({ body: "first", replacedAt: "2026-09-19T00:00:00.000Z" });
  });

  it("keeps twenty versions and drops the oldest on the twenty-first", () => {
    let history: InstructionVersion[] = [];
    for (let i = 0; i < 21; i++) {
      history = pushInstructionVersion({ history, body: `version ${i}`, replacedAt: `2026-09-19T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    expect(history).toHaveLength(MAX_INSTRUCTION_VERSIONS);
    expect(history[0]).toEqual({ body: "version 20", replacedAt: "2026-09-19T00:00:20.000Z" });
    expect(history.some((version) => version.body === "version 0")).toBe(false);
  });
});

describe("assistant models, the instructions prompt section", () => {
  it("puts the user's document under a heading that says it is the user's", () => {
    const section = instructionsSection("Keep replies short.");
    expect(section).toMatch(/user's standing instructions/i);
    expect(section).toContain("Keep replies short.");
  });

  it("says the user's document beats the defaults", () => {
    expect(instructionsSection("Keep replies short.")).toMatch(/user's document wins/i);
  });

  it("says DocMind's own rules beat the user's document", () => {
    const section = instructionsSection("Keep replies short.");
    expect(section).toMatch(/decided in DocMind's\s+code/i);
    expect(section).toMatch(/tool/i);
    expect(section).toMatch(/confirm/i);
  });

  it("marks the document as instructions, not as something to answer questions from", () => {
    const section = instructionsSection("Keep replies short.");
    expect(section).toMatch(/not a document to quote from or\s+answer questions about/i);
    expect(section).toContain("<user-instructions>");
    expect(section).toContain("</user-instructions>");
  });

  it("leaves the section out entirely for an empty document", () => {
    expect(instructionsSection("")).toBe("");
    expect(instructionsSection("   ")).toBe("");
  });

  it("keeps the withheld-writes notice above the instructions", () => {
    const prompt = buildAssistantPrompt({
      basePrompt: "Base.",
      tools: [],
      writesWithheld: true,
      instructions: "Keep replies short.",
    });
    const noticeIndex = prompt.indexOf("/note");
    const instructionsIndex = prompt.indexOf("user's standing instructions");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(instructionsIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(instructionsIndex);
  });

  it("leaves buildAssistantPrompt's own output unchanged when no instructions are given", () => {
    const prompt = buildAssistantPrompt({ basePrompt: "Base.", tools: [], writesWithheld: false });
    expect(prompt).not.toContain("user's standing instructions");
  });
});

describe("assistant models, withInstructions", () => {
  it("appends the instructions section to the base prompt", () => {
    const result = withInstructions("Base prompt.", "Keep replies short.");
    expect(result.startsWith("Base prompt.")).toBe(true);
    expect(result).toContain("Keep replies short.");
  });

  it("returns the base prompt unchanged for a blank document", () => {
    expect(withInstructions("Base prompt.", "")).toBe("Base prompt.");
  });
});
