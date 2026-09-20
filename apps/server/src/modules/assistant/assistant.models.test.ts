import { describe, expect, it } from "vitest";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import type { ToolDefinition } from "../ai/ai.types.js";
import { CHAT_SYSTEM_PROMPT, TELEGRAM_ASSISTANT_SYSTEM_PROMPT } from "../chat/chat.models.js";
import type { InstructionVersion } from "./assistant.types.js";
import {
  answeringPromptFor,
  appendInstructionLine,
  assertInstructionsWithinCap,
  ASSISTANT_TRIAGE_SYSTEM_PROMPT,
  assistantTroubleReply,
  buildAssistantPrompt,
  commandTurnText,
  DEFAULT_INSTRUCTIONS,
  duplicateReply,
  ensureQuestionMark,
  instructionAddedReply,
  instructionsSection,
  MAX_INSTRUCTION_VERSIONS,
  MAX_INSTRUCTIONS_CHARS,
  missingNoteTextReply,
  newProposalId,
  newThreadReply,
  noteSourceFor,
  proposalDeclinedReply,
  pushInstructionVersion,
  quotedForConfirmation,
  readConfirmationAnswer,
  receivedReply,
  requireSession,
  requiresCommandConfirmation,
  requiresConfirmation,
  resolveQuestion,
  staleProposalReply,
  textDocumentName,
  toolsUnsupportedNotice,
  unavailableProposalReply,
  WARN_INSTRUCTIONS_CHARS,
  withInstructions,
  withoutEmDashes,
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

    const prompt = buildAssistantPrompt({ basePrompt: "Base prompt.", tools });

    expect(prompt).toContain("Base prompt.");
    expect(prompt).toContain("answerFromDocuments");
    expect(prompt).toContain("Answer from the user's own documents.");
    expect(prompt).toContain("startNewThread");
    expect(prompt).not.toMatch(/\/note/);
  });

  it("tells the model a write waits for the user, and says nothing about /note any more", () => {
    const prompt = buildAssistantPrompt({ basePrompt: "Base.", tools: [] });
    expect(prompt).toMatch(/waits for their answer/i);
    expect(prompt).toMatch(/never say you have done it/i);
    expect(prompt).not.toMatch(/\/note/);
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

describe("ASSISTANT_TRIAGE_SYSTEM_PROMPT", () => {
  // The bug a live probe found: a triage call never receives retrieved document text
  // (Decision 2 of the assistant triage plan), so a prompt telling it to "answer from
  // the context given to you" is false on every single call it makes, and a model told
  // that will report back a missing capability it does not actually have.
  it("never tells the model to answer from context it was given", () => {
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).not.toMatch(/context given to you/i);
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).not.toMatch(/context does not cover/i);
  });

  it("tells the model never to claim it has no way to look something up", () => {
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/never tell the user you have no way to check/i);
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).not.toMatch(/can'?t (check|look|list)/i);
  });

  it("routes anything the user may have filed to answerFromDocuments, not to memory", () => {
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/use answerFromDocuments/i);
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/never answer/i);
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/from memory/i);
  });

  it("keeps the conversational character for a message with nothing to do with a document", () => {
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/chat normally/i);
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/never refuse/i);
  });

  it("still treats document text as data to read, not instructions to follow", () => {
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/data to read/i);
    expect(ASSISTANT_TRIAGE_SYSTEM_PROMPT).toMatch(/never a command to follow/i);
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

  it("keeps the confirmation paragraph above the user's instructions", () => {
    const prompt = buildAssistantPrompt({
      basePrompt: "Base.",
      tools: [],
      instructions: "Keep replies short.",
    });
    const noticeIndex = prompt.indexOf("waits for their answer");
    const instructionsIndex = prompt.indexOf("user's standing instructions");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(instructionsIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(instructionsIndex);
  });

  it("leaves buildAssistantPrompt's own output unchanged when no instructions are given", () => {
    const prompt = buildAssistantPrompt({ basePrompt: "Base.", tools: [] });
    expect(prompt).not.toContain("user's standing instructions");
  });
});

describe("assistant models, answeringPromptFor", () => {
  it("picks the telegram assistant prompt for the telegram surface", () => {
    expect(answeringPromptFor("telegram")).toBe(TELEGRAM_ASSISTANT_SYSTEM_PROMPT);
  });

  it("picks the app's own chat prompt for the app surface", () => {
    expect(answeringPromptFor("app")).toBe(CHAT_SYSTEM_PROMPT);
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

describe("assistant models, requiresConfirmation", () => {
  it("requires confirmation for a capability that writes or that deletes", () => {
    expect(requiresConfirmation({ writes: true, destructive: false })).toBe(true);
    expect(requiresConfirmation({ writes: false, destructive: true })).toBe(true);
    expect(requiresConfirmation({ writes: true, destructive: true })).toBe(true);
  });

  it("requires no confirmation for a capability that neither writes nor deletes", () => {
    expect(requiresConfirmation({ writes: false, destructive: false })).toBe(false);
  });

  it("requires a command's own confirmation only when the capability is destructive", () => {
    expect(requiresCommandConfirmation({ destructive: true })).toBe(true);
    expect(requiresCommandConfirmation({ destructive: false })).toBe(false);
  });
});

describe("assistant models, reading a plain-text answer", () => {
  it("reads a message that is only an affirmation as yes", () => {
    for (const text of ["yes", "Yeah", "yep", "yup", "ok", "Okay", "sure", "go ahead", "do it", "  yes  ", "Yes!"]) {
      expect(readConfirmationAnswer(text)).toBe("yes");
    }
  });

  it("reads a message that is only a refusal as no", () => {
    for (const text of ["no", "Nope", "nah", "cancel", "never mind", "don't", "No."]) {
      expect(readConfirmationAnswer(text)).toBe("no");
    }
  });

  it("does not read a sentence that merely contains yes as an answer", () => {
    expect(readConfirmationAnswer("yes, and what is my excess?")).toBe("unrelated");
    expect(readConfirmationAnswer("yes but not today")).toBe("unrelated");
  });

  it("reads an empty or punctuation-only message as unrelated", () => {
    expect(readConfirmationAnswer("")).toBe("unrelated");
    expect(readConfirmationAnswer("   ")).toBe("unrelated");
    expect(readConfirmationAnswer("...")).toBe("unrelated");
    expect(readConfirmationAnswer("???")).toBe("unrelated");
  });
});

describe("assistant models, quotedForConfirmation", () => {
  it("shortens a long quote in a confirm sentence", () => {
    const longText = "x".repeat(3000);

    const quoted = quotedForConfirmation(longText);

    expect(quoted.length).toBeLessThan(longText.length);
    expect(quoted.endsWith("...")).toBe(true);
    expect(quoted.startsWith("x".repeat(400))).toBe(true);
  });

  it("leaves a short quote unchanged", () => {
    expect(quotedForConfirmation("buy milk")).toBe("buy milk");
  });
});

describe("assistant models, proposal ids and replies", () => {
  it("generates a proposal id with a stable prefix, never the same one twice", () => {
    expect(newProposalId()).toMatch(/^prop_[0-9a-f]{12}$/);
    expect(newProposalId()).not.toBe(newProposalId());
  });

  it("declines, tells a stale answer apart, and says a tool is gone, all in plain sentences", () => {
    expect(proposalDeclinedReply().length).toBeGreaterThan(0);
    expect(staleProposalReply().length).toBeGreaterThan(0);
    expect(unavailableProposalReply().length).toBeGreaterThan(0);
  });
});

describe("assistant models, withoutEmDashes", () => {
  // Verbatim from a live database read: six em dashes across five of the last twelve
  // assistant replies, the count that made this a code guarantee instead of a prompt.
  it("turns a spaced dash between two clauses into a comma", () => {
    const result = withoutEmDashes("I can't list or count your documents — I only have access to search results");
    expect(result).not.toMatch(/[–—]/);
    expect(result).toBe("I can't list or count your documents, I only have access to search results");
  });

  it("turns an unspaced dash jammed between two words into a comma", () => {
    const result = withoutEmDashes("I can check for anything more recent—or point me");
    expect(result).not.toMatch(/[–—]/);
    expect(result).toBe("I can check for anything more recent, or point me");
  });

  it("turns a dash before a quoted filename into a comma, leaving the filename's own hyphen alone", () => {
    const result = withoutEmDashes("one — **Flight_approve-ballooned-itinerary.pdf**");
    expect(result).not.toMatch(/[–—]/);
    expect(result).toBe("one, **Flight_approve-ballooned-itinerary.pdf**");
  });

  it("turns an en dash between two numbers into a plain hyphen, since that is a range", () => {
    expect(withoutEmDashes("2020–2024")).toBe("2020-2024");
  });

  it("leaves a plain hyphen alone, including inside a filename", () => {
    expect(withoutEmDashes("Flight_approve-ballooned-itinerary.pdf")).toBe("Flight_approve-ballooned-itinerary.pdf");
    expect(withoutEmDashes("well-known fact")).toBe("well-known fact");
  });

  it("leaves text with no dash of any kind unchanged", () => {
    expect(withoutEmDashes("Nothing to change here.")).toBe("Nothing to change here.");
  });

  it("leaves an empty string as is", () => {
    expect(withoutEmDashes("")).toBe("");
  });
});

describe("assistant models, appendInstructionLine", () => {
  it("adds a bullet after what is already under the user's own heading", () => {
    const body = "## Things I care about\n- Existing line.";

    const updated = appendInstructionLine({ body, line: "New line." });

    expect(updated).toBe("## Things I care about\n- Existing line.\n- New line.");
  });

  it("keeps a later heading's own content untouched", () => {
    const body = "## Things I care about\n- Existing line.\n\n## Notes and saving\n- Keep my wording.";

    const updated = appendInstructionLine({ body, line: "New line." });

    expect(updated).toBe("## Things I care about\n- Existing line.\n- New line.\n\n## Notes and saving\n- Keep my wording.");
  });

  it("creates the heading at the end of the document when it has none", () => {
    const updated = appendInstructionLine({ body: "Keep replies short.", line: "Rent is always urgent." });

    expect(updated).toBe("Keep replies short.\n\n## Things I care about\n- Rent is always urgent.");
  });

  it("creates the heading in an empty document with no leading blank lines", () => {
    const updated = appendInstructionLine({ body: "", line: "Rent is always urgent." });

    expect(updated).toBe("## Things I care about\n- Rent is always urgent.");
  });

  it("names a reply that says the write happened", () => {
    expect(instructionAddedReply().length).toBeGreaterThan(0);
  });
});
