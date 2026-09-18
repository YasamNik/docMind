import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { aiApi, isProviderAdded } from "@/lib/ai-api";
import { settingsApi } from "@/lib/settings-api";
import { ProviderCard } from "./ProviderCard";
import { ModelSlotRow } from "./ModelSlotRow";

export function AiTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: () => aiApi.providers(),
  });
  // Only one added provider card is expanded at a time. Defaults to the first added
  // provider, until the user picks a different one.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const addProvider = useMutation({
    mutationFn: async (id: string) => {
      await settingsApi.update({ [`ai.${id}.enabled`]: true });
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setExpandedId(id);
      setAddOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data) return null;

  const { providers, slots } = data;
  const addedProviders = providers.filter((p) => isProviderAdded(p, slots));
  const notAddedProviders = providers.filter((p) => !isProviderAdded(p, slots));
  const activeExpandedId = expandedId ?? addedProviders[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-lg">Providers</h2>
          <Button size="sm" onClick={() => setAddOpen(true)}>Add provider</Button>
        </div>

        {addedProviders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add at least one provider to use AI features such as sorting, chat, and search.
          </p>
        ) : (
          addedProviders.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              expanded={p.id === activeExpandedId}
              onExpand={() => setExpandedId(p.id)}
              slots={slots}
            />
          ))
        )}
      </section>

      <section className="space-y-4">
        <h2 className="font-heading text-lg">Model slots</h2>
        <p className="text-sm text-muted-foreground">
          Pick a provider and model for each task. The rules slot must use a model that supports structured output.
        </p>
        {Object.entries(slots).map(([slot, info]) => (
          <ModelSlotRow key={slot} slot={slot} slotInfo={info} providers={addedProviders} />
        ))}
      </section>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a provider</DialogTitle>
          </DialogHeader>
          {notAddedProviders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every provider is already added.</p>
          ) : (
            <div className="space-y-1.5">
              {notAddedProviders.map((p) => (
                <Button
                  key={p.id}
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => addProvider.mutate(p.id)}
                  disabled={addProvider.isPending}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
