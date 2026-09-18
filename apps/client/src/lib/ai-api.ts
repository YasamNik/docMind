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
  enabled: boolean;
  keySet: boolean;
  keyLastFour?: string;
  baseUrl: { value: string; source: string };
};

// A provider is "added" (shown as a card) when the user explicitly enabled it, or when
// it already has a key set. The key-set clause is backward compatibility for providers
// configured before the enabled flag existed, so they keep showing without a migration.
// A provider counts as added when the user added it explicitly, when it already holds a
// key, or when a model slot still points at it. The last two clauses are what keeps a
// setup made before the enabled flag existed from vanishing off this page. The slot
// clause carries Ollama and LM Studio in particular: they need no key, so keySet is
// always false for them and they would otherwise disappear while a slot still used them.
export function isProviderAdded(provider: ProviderInfo, slots?: Record<string, SlotInfo>): boolean {
  if (provider.enabled || provider.keySet) return true;
  if (!slots) return false;
  return Object.values(slots).some((info) => info.value?.startsWith(`${provider.id}://`));
}

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
  async testSlot(slot: string) {
    return api.json<TestResult>("POST", `/api/ai/slots/${slot}/test`, {});
  },
};
