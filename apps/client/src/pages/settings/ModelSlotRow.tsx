import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aiApi, type ProviderInfo, type SlotInfo, type ModelInfo } from "@/lib/ai-api";
import { settingsApi } from "@/lib/settings-api";

const SLOT_LABELS: Record<string, string> = {
  rules: "Rules (sorting)",
  chat: "Chat",
  embedding: "Embedding",
  vision: "Vision (OCR fallback)",
};

export function ModelSlotRow({
  slot,
  slotInfo,
  providers,
}: {
  slot: string;
  slotInfo: SlotInfo;
  providers: ProviderInfo[];
}) {
  const queryClient = useQueryClient();

  // Parse current value
  const currentUri = typeof slotInfo.value === "string" ? slotInfo.value : "";
  const parts = currentUri.match(/^([a-z0-9_-]+):\/\/(.+)$/);
  const currentProviderId = parts?.[1] ?? "";
  const currentModel = parts?.[2] ?? "";

  const [selectedProvider, setSelectedProvider] = useState(currentProviderId || providers[0]?.id || "");
  const [modelInput, setModelInput] = useState(currentModel);

  useEffect(() => {
    if (currentProviderId) setSelectedProvider(currentProviderId);
    if (currentModel) setModelInput(currentModel);
  }, [currentProviderId, currentModel]);

  // Fetch models for the selected provider
  const { data: modelsData, isFetching: isFetchingModels } = useQuery({
    queryKey: ["ai-models", selectedProvider],
    queryFn: () => aiApi.models(selectedProvider),
    enabled: !!selectedProvider,
    staleTime: 10 * 60 * 1000,
  });

  // Get the suggestion placeholder
  const suggestionParts = slotInfo.suggestion?.match(/^([a-z0-9_-]+):\/\/(.+)$/);
  const suggestedModel = suggestionParts?.[2] ?? "";

  const save = useMutation({
    mutationFn: async () => {
      const value = modelInput ? `${selectedProvider}://${modelInput}` : "";
      await settingsApi.update({ [`ai.model.${slot}`]: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      toast.success("Model saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testSlot = useMutation({
    mutationFn: () => aiApi.testSlot(slot),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Test failed";
      toast.error(msg === "Request failed" ? "Could not reach the model. Check the model name and try saving first." : msg);
    },
  });

  const clear = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.model.${slot}`]: "" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setModelInput("");
      toast.success("Model cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="space-y-1 min-w-0 flex-1">
        <Label>{SLOT_LABELS[slot] ?? slot}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            value={selectedProvider}
            onChange={(e) => { setSelectedProvider(e.target.value); setModelInput(""); }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <Input
            placeholder={suggestedModel || "Model name"}
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            list={`models-${slot}`}
            className="flex-1"
          />
          {modelsData?.models && modelsData.models.length > 0 && (
            <datalist id={`models-${slot}`}>
              {modelsData.models.map((m: ModelInfo) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </datalist>
          )}
        </div>
        {isFetchingModels && (
          <p className="text-xs text-muted-foreground">Loading models...</p>
        )}
        {!isFetchingModels && modelsData?.error && (
          <p className="text-xs text-muted-foreground">{modelsData.error}</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
        {currentUri && (
          <>
            <Button size="sm" variant="secondary" onClick={() => testSlot.mutate()} disabled={testSlot.isPending}>
              {testSlot.isPending ? "Testing..." : "Test"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending}>Clear</Button>
          </>
        )}
      </div>
    </div>
  );
}
