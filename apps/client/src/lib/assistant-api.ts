import { api } from "./api";

export type InstructionVersion = { body: string; replacedAt: string };

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
};
