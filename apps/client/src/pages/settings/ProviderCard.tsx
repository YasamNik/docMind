import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRightIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { aiApi, type ProviderInfo, type SlotInfo, type TestResult } from "@/lib/ai-api";
import { settingsApi } from "@/lib/settings-api";
import { SLOT_LABELS } from "./ai-slot-labels";

// Shared with the storage settings tab, so a setup guide looks and behaves the same
// wherever it appears: numbered steps, an optional link, an optional copy button, then
// the notes below a divider.
export type SetupGuide = {
  title: string;
  intro: string;
  steps: { text: string; link?: string; copyValue?: string }[];
  notes: string[];
};

export function GuideCard({ guide }: { guide: SetupGuide }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{guide.title}</p>
      <p className="text-muted-foreground">{guide.intro}</p>
      <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
        {guide.steps.map((step, i) => (
          <li key={i}>
            {step.text}
            {step.link && (
              <>
                {" "}
                <a href={step.link} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  Open
                </a>
              </>
            )}
            {step.copyValue && (
              <>
                {" "}
                <button
                  className="underline underline-offset-2 text-foreground"
                  onClick={() => { navigator.clipboard.writeText(step.copyValue!); toast.success("Copied"); }}
                >
                  Copy
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {guide.notes.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-1 pt-1 border-t">
          {guide.notes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProviderCard({
  provider,
  expanded,
  onExpand,
  slots,
}: {
  provider: ProviderInfo;
  expanded: boolean;
  onExpand: () => void;
  slots: Record<string, Pick<SlotInfo, "value">>;
}) {
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const [showKeyField, setShowKeyField] = useState(!provider.keySet);
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [showBaseUrlField, setShowBaseUrlField] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const blockingSlots = Object.entries(slots)
    .filter(([, info]) => typeof info.value === "string" && info.value.startsWith(`${provider.id}://`))
    .map(([slot]) => SLOT_LABELS[slot] ?? slot);

  const removeProvider = useMutation({
    mutationFn: async () => {
      const updates: Record<string, unknown> = { [`ai.${provider.id}.enabled`]: false };
      if (provider.requiresKey) updates[`ai.${provider.id}.apiKey`] = null;
      await settingsApi.update(updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setRemoveOpen(false);
      toast.success("Provider removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveKey = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.${provider.id}.apiKey`]: keyInput });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setKeyInput("");
      setShowKeyField(false);
      toast.success("Key saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearKey = useMutation({
    mutationFn: async () => {
      // The settings service clears a value for either `null` or, for secrets only,
      // `""`. Use `null` here to match the base URL clear below.
      await settingsApi.update({ [`ai.${provider.id}.apiKey`]: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setShowKeyField(true);
      toast.success("Key cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveBaseUrl = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [`ai.${provider.id}.baseUrl`]: baseUrlInput || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
      setShowBaseUrlField(false);
      toast.success("Base URL saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: () => aiApi.testProvider(provider.id),
    onSuccess: (result) => setTestResult(result),
    onError: (e: Error) => setTestResult({ ok: false, latencyMs: 0, message: e.message }),
  });

  const keyStatusSummary = provider.requiresKey
    ? provider.keySet
      ? `Key set${provider.keyLastFour ? `, ends in ····${provider.keyLastFour}` : ""}`
      : "Key not set"
    : "No key required";

  if (!expanded) {
    return (
      <Card>
        <button
          type="button"
          onClick={onExpand}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm"
        >
          <span className="font-medium">{provider.label}</span>
          <span className="flex items-center gap-2 text-muted-foreground">
            {keyStatusSummary}
            <ChevronRightIcon className="size-4" />
          </span>
        </button>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <button type="button" onClick={onExpand} className="text-left">
          <CardTitle>{provider.label}</CardTitle>
        </button>
        <Button size="sm" variant="destructive" onClick={() => setRemoveOpen(true)}>
          Remove
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {/* API Key */}
            {provider.requiresKey && (
              <div className="space-y-1.5">
                <Label>API Key</Label>
                {provider.keySet && !showKeyField ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Set, ends in {provider.keyLastFour ? `····${provider.keyLastFour}` : "****"}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setShowKeyField(true)}>Replace</Button>
                    <Button size="sm" variant="outline" onClick={() => clearKey.mutate()} disabled={clearKey.isPending}>Clear</Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      type="password"
                      placeholder="Paste your API key"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                    <Button size="sm" onClick={() => saveKey.mutate()} disabled={!keyInput || saveKey.isPending}>Save</Button>
                    {provider.keySet && (
                      <Button size="sm" variant="outline" onClick={() => setShowKeyField(false)}>Cancel</Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Base URL */}
            <div className="space-y-1.5">
              <Label>Base URL</Label>
              {!showBaseUrlField ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground truncate max-w-xs">{provider.baseUrl.value || "(not set)"}</span>
                  {provider.baseUrl.source === "env" && <Badge variant="secondary">from environment</Badge>}
                  <Button size="sm" variant="outline" onClick={() => { setBaseUrlInput(provider.baseUrl.value); setShowBaseUrlField(true); }}>
                    Edit
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Input
                    placeholder={provider.defaultBaseUrl || "https://..."}
                    value={baseUrlInput}
                    onChange={(e) => setBaseUrlInput(e.target.value)}
                  />
                  <Button size="sm" onClick={() => saveBaseUrl.mutate()} disabled={saveBaseUrl.isPending}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setShowBaseUrlField(false)}>Cancel</Button>
                </div>
              )}
            </div>

            {/* Test */}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                {test.isPending ? "Testing..." : "Test"}
              </Button>
              {testResult && (
                <span className={`text-sm ${testResult.ok ? "text-org-accent2-700" : "text-destructive"}`}>
                  {testResult.ok ? `OK (${testResult.latencyMs}ms)` : testResult.message}
                </span>
              )}
            </div>
          </div>

          {/* Guide */}
          <GuideCard guide={provider.guide} />
        </div>
      </CardContent>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {provider.label}?</DialogTitle>
          </DialogHeader>
          {blockingSlots.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground">
                {provider.label} is still used by the {blockingSlots.join(", ")} model slot
                {blockingSlots.length > 1 ? "s" : ""}. Change that slot to another provider before removing it.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRemoveOpen(false)}>Close</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {provider.requiresKey
                  ? "This deletes the saved API key. It cannot be recovered."
                  : "This removes the provider's card from this page. Nothing is deleted, and you can add it back at any time."}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRemoveOpen(false)}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => removeProvider.mutate()}
                  disabled={removeProvider.isPending}
                >
                  Remove provider
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
