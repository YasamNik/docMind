import { useQuery } from "@tanstack/react-query";
import { aiApi } from "@/lib/ai-api";
import { ProviderCard } from "./ProviderCard";
import { ModelSlotRow } from "./ModelSlotRow";

export function AiTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: () => aiApi.providers(),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data) return null;

  const { providers, slots } = data;

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-lg font-medium">Providers</h2>
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Model slots</h2>
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
