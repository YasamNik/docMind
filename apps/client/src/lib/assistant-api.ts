import { api } from "./api";
import type { Citation } from "./chat-api";

export type InstructionVersion = { body: string; replacedAt: string };

// The client-facing half of a pending proposal, the same shape GET
// /api/assistant/sessions/:sessionId/proposal returns (assistant.types.ts, server side).
export type PendingProposal = {
  id: string;
  tool: string;
  text: string;
  messageId: string;
  proposedAt: string;
};

export type ProposalAnswerResult = {
  status: "ran" | "declined" | "stale";
  reply: string;
  citations: Citation[];
  toolUsed: string | null;
};

export type InstructionsView = {
  body: string;
  source: string;
  maxChars: number;
  warnChars: number;
  // The shipped default document's own text, so the tab can offer a reset without
  // holding its own copy that could drift from the server's.
  shippedDefault: string;
  history: InstructionVersion[];
};

export const assistantApi = {
  async instructions() {
    return api.get<InstructionsView>("/api/assistant/instructions");
  },
  async saveInstructions(body: string) {
    return api.json<InstructionsView>("PUT", "/api/assistant/instructions", { body });
  },
  async restoreInstructions(replacedAt: string) {
    return api.json<InstructionsView>("POST", "/api/assistant/instructions/restore", { replacedAt });
  },
  async getPendingProposal(sessionId: string) {
    return (await api.get<{ proposal: PendingProposal | null }>(`/api/assistant/sessions/${sessionId}/proposal`)).proposal;
  },
  answerProposal(sessionId: string, proposalId: string, decision: "yes" | "no") {
    return api.json<ProposalAnswerResult>("POST", `/api/assistant/sessions/${sessionId}/proposal/answer`, { proposalId, decision });
  },
};
