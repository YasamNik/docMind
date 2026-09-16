import { api } from "./api";

export type ProviderInfo = {
  id: string;
  label: string;
  adapter: string;
  defaultBaseUrl: string;
  requiresKey: boolean;
  capabilities: { text: boolean; structured: boolean; embeddings: boolean; listModels: boolean };
  suggestedModels: { rules?: string; chat?: string; embedding?: string };
  guide: { title: string; intro: string; steps: { text: string; link?: string; copyValue?: string }[]; notes: string[] };
  keySet: boolean;
  keyLastFour?: string;
  baseUrl: { value: string; source: string };
};

export type SlotInfo = {
  value: string;
  source: string;
  suggestion?: string;
};

export type ModelInfo = {
  id: string;
  label: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  supportsStructured?: boolean;
};

export type TestResult = { ok: boolean; latencyMs: number; message: string };

export const aiApi = {
  async providers() {
    return api.get<{ providers: ProviderInfo[]; slots: Record<string, SlotInfo> }>("/api/ai/providers");
  },
  async testProvider(id: string) {
    return api.json<TestResult>("POST", `/api/ai/providers/${id}/test`, {});
  },
  async models(id: string) {
    return api.get<{ models: ModelInfo[]; error?: string }>(`/api/ai/providers/${id}/models`);
  },
};
