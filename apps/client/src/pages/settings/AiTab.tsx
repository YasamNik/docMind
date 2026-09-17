import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiApi } from "@/lib/ai-api";
import { ProviderCard } from "./ProviderCard";
import { ModelSlotRow } from "./ModelSlotRow";

export function AiTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: () => aiApi.providers(),
  });
  // Only one provider card is expanded at a time. Defaults to the first provider in
  // registry order (OpenRouter), per spec 7.5, until the user picks a different one.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data) return null;

  const { providers, slots } = data;
  const activeExpandedId = expandedId ?? providers[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="font-heading text-lg font-medium">Providers</h2>
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            expanded={p.id === activeExpandedId}
            onExpand={() => setExpandedId(p.id)}
          />
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="font-heading text-lg font-medium">Model slots</h2>
        <p className="text-sm text-muted-foreground">
          Pick a provider and model for each task. The rules slot must use a model that supports structured output.
        </p>
        {Object.entries(slots).map(([slot, info]) => (
          <ModelSlotRow key={slot} slot={slot} slotInfo={info} providers={providers} />
        ))}
      </section>
    </div>
  );
}
