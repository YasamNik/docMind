import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantApi } from "./assistant-api";

afterEach(() => vi.restoreAllMocks());

describe("assistantApi", () => {
  it("fetches the pending proposal for a session", async () => {
    const proposal = { id: "prop_1", tool: "saveNote", text: "Save that as a note?", messageId: "msg_1", proposedAt: "now" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ proposal }), { status: 200 }));
    const result = await assistantApi.getPendingProposal("sess_1");
    expect(result).toEqual(proposal);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/assistant/sessions/sess_1/proposal");
  });

  it("returns null when nothing is waiting", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ proposal: null }), { status: 200 }));
    const result = await assistantApi.getPendingProposal("sess_1");
    expect(result).toBeNull();
  });

  it("answers a proposal", async () => {
    const answer = { status: "ran", reply: "Got it. Added \"note.txt\" to DocMind.", citations: [], toolUsed: "saveNote" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(answer), { status: 200 }));
    const result = await assistantApi.answerProposal("sess_1", "prop_1", "yes");
    expect(result).toEqual(answer);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/assistant/sessions/sess_1/proposal/answer");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ proposalId: "prop_1", decision: "yes" }) });
  });
});
