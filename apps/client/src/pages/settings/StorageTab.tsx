import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { storageApi, type StorageDriverSummary, type StorageTestResult } from "@/lib/storage-api";
import { settingsApi, type ResolvedSetting } from "@/lib/settings-api";
import { GuideCard } from "./ProviderCard";

function documentCountLabel(count: number) {
  return `${count} document${count === 1 ? "" : "s"}`;
}

export function StorageTab() {
  const queryClient = useQueryClient();
  const { data: drivers = [] } = useQuery({
    queryKey: ["storage-drivers"],
    queryFn: () => storageApi.list(),
  });
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.list(),
  });

  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, StorageTestResult>>({});
  const [confirmSwitch, setConfirmSwitch] = useState<StorageDriverSummary | null>(null);

  const activeDriver = drivers.find((d) => d.active) ?? null;
  const selectedId = browsingId ?? activeDriver?.id ?? drivers[0]?.id ?? null;
  const selected = drivers.find((d) => d.id === selectedId) ?? null;

  const test = useMutation({
    mutationFn: (id: string) => storageApi.test(id),
  });

  const switchDriver = useMutation({
    mutationFn: (id: string) => settingsApi.update({ "storage.activeDriver": id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage-drivers"] });
      // The library and its sidebar counts are scoped to the active storage, so both
      // need to refetch once the switch lands, alongside the settings the tab reads.
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setConfirmSwitch(null);
      toast.success("Storage switched");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Runs the driver's health check and records the result under its own id, so the same
  // message shows whether it came from the Test button or from a switch attempt.
  async function runHealthCheck(driverId: string) {
    const result = await test.mutateAsync(driverId).catch((e: Error) => ({ ok: false, message: e.message }));
    setTestResults((prev) => ({ ...prev, [driverId]: result }));
    return result;
  }

  async function requestSwitch(driver: StorageDriverSummary) {
    const result = await runHealthCheck(driver.id);
    if (result.ok) setConfirmSwitch(driver);
  }

  if (drivers.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading storage drivers...</p>;
  }

  const driverSettings = selected ? settings.filter((s) => s.key.startsWith(`storage.${selected.id}.`)) : [];
  const selectedTestResult = selected ? testResults[selected.id] : undefined;

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Storage drivers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {drivers.map((driver) => (
            <button
              key={driver.id}
              type="button"
              onClick={() => setBrowsingId(driver.id)}
              className={`w-full space-y-1 rounded-lg border p-3 text-left text-sm ${
                driver.id === selectedId ? "border-primary" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{driver.label}</span>
                {driver.active && <Badge variant="secondary">Active</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{documentCountLabel(driver.documentCount)}</p>
            </button>
          ))}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>{selected.label}</CardTitle>
            {!selected.active && (
              <Button
                size="sm"
                onClick={() => requestSwitch(selected)}
                disabled={!selected.configured || test.isPending}
                title={selected.configured ? undefined : "Add the settings this driver needs before switching."}
              >
                Switch to {selected.label}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                {driverSettings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This driver needs no settings.</p>
                ) : (
                  driverSettings.map((setting) => (
                    <DriverSettingField key={setting.key} setting={setting} queryClient={queryClient} />
                  ))
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runHealthCheck(selected.id)}
                    disabled={test.isPending}
                  >
                    {test.isPending ? "Testing..." : "Test"}
                  </Button>
                  {selectedTestResult && (
                    <span className={`text-sm ${selectedTestResult.ok ? "text-org-accent2-700" : "text-destructive"}`}>
                      {selectedTestResult.message}
                    </span>
                  )}
                </div>
              </div>

              <GuideCard guide={selected.guide} />
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmSwitch !== null} onOpenChange={(open) => !open && setConfirmSwitch(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch to {confirmSwitch?.label}?</DialogTitle>
          </DialogHeader>
          {confirmSwitch && activeDriver && (
            <p className="text-sm text-muted-foreground">
              {documentCountLabel(activeDriver.documentCount)} on {activeDriver.label} will leave the library view, and{" "}
              {documentCountLabel(confirmSwitch.documentCount)} on {confirmSwitch.label} will join it. Search and chat
              keep finding all of them, whichever storage is active.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSwitch(null)}>Cancel</Button>
            <Button onClick={() => confirmSwitch && switchDriver.mutate(confirmSwitch.id)} disabled={switchDriver.isPending}>
              Switch storage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DriverSettingField({ setting, queryClient }: { setting: ResolvedSetting; queryClient: QueryClient }) {
  const [value, setValue] = useState("");
  const maskedInitial = setting.secret ? (setting.value as { isSet: boolean } | undefined) : undefined;
  const [editing, setEditing] = useState(setting.secret ? !maskedInitial?.isSet : false);

  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [setting.key]: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setValue("");
      setEditing(false);
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clear = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [setting.key]: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setEditing(true);
      toast.success("Cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shortKey = setting.key.split(".").slice(2).join(".");

  if (setting.secret) {
    const masked = setting.value as { isSet: boolean; lastFour?: string };
    return (
      <div className="space-y-1.5">
        <Label>{shortKey}</Label>
        <p className="text-xs text-muted-foreground">{setting.doc}</p>
        {masked.isSet && !editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Set, ends in {masked.lastFour ? `····${masked.lastFour}` : "****"}
            </span>
            <Button size="sm" variant="outline" onClick={() => { setValue(""); setEditing(true); }}>Replace</Button>
            <Button size="sm" variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending}>Clear</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              placeholder="Paste the value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button size="sm" onClick={() => save.mutate()} disabled={!value || save.isPending}>Save</Button>
            {masked.isSet && (
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label>{shortKey}</Label>
      <p className="text-xs text-muted-foreground">{setting.doc}</p>
      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{String(setting.value ?? "(not set)")}</span>
          {setting.source === "env" && <Badge variant="secondary">from environment</Badge>}
          {setting.source === "default" && <Badge variant="secondary">default</Badge>}
          <Button size="sm" variant="outline" onClick={() => { setValue(String(setting.value ?? "")); setEditing(true); }}>Edit</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
