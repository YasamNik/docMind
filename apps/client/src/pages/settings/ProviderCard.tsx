import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRightIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { aiApi, type ProviderInfo, type TestResult } from "@/lib/ai-api";
import { settingsApi } from "@/lib/settings-api";

export function ProviderCard({
  provider,
  expanded,
  onExpand,
}: {
  provider: ProviderInfo;
  expanded: boolean;
  onExpand: () => void;
}) {
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const [showKeyField, setShowKeyField] = useState(!provider.keySet);
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [showBaseUrlField, setShowBaseUrlField] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

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
      <CardHeader>
        <button type="button" onClick={onExpand} className="text-left">
          <CardTitle>{provider.label}</CardTitle>
        </button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
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
          <div className="space-y-2 text-sm">
            <p className="font-medium">{provider.guide.title}</p>
            <p className="text-muted-foreground">{provider.guide.intro}</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              {provider.guide.steps.map((step, i) => (
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
            {provider.guide.notes.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1 pt-1 border-t">
                {provider.guide.notes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
