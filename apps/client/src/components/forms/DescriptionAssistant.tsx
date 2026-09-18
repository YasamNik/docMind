import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { descriptionAssistantApi } from "@/lib/description-assistant-api";

export function DescriptionAssistant({
  targetType,
  name,
  description,
  onUse,
}: {
  targetType: "tag" | "category";
  name: string;
  description: string;
  onUse: (text: string) => void;
}) {
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const suggest = useMutation({
    mutationFn: () => descriptionAssistantApi.suggest({ targetType, name, description }),
    onSuccess: (data) => setSuggestion(data.suggestion),
    onError: (e: Error) => toast.error(e.message),
  });

  const label = description.trim().length > 0 ? "Improve with AI" : "Draft with AI";

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={!name.trim() || suggest.isPending}
        onClick={() => suggest.mutate()}
      >
        {label}
      </Button>

      {suggestion !== null && (
        <div className="space-y-2 rounded-2xl border border-dashed border-primary/60 bg-secondary/60 p-3 text-sm">
          <p>{suggestion}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              onClick={() => {
                onUse(suggestion);
                setSuggestion(null);
              }}
            >
              Use it
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setSuggestion(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
