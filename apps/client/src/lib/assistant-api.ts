import { api } from "./api";

export type InstructionVersion = { body: string; replacedAt: string };

export type InstructionsView = {
  body: string;
  source: string;
  maxChars: number;
  warnChars: number;
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
