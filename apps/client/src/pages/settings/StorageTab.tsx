import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { storageApi, type StorageDriverSummary, type StorageTestResult } from "@/lib/storage-api";
import { settingsApi, type ResolvedSetting } from "@/lib/settings-api";
import { clearStorageReauthRequired, useStorageReauthRequired } from "@/lib/storage-reauth";
import { GuideCard } from "./ProviderCard";

function documentCountLabel(count: number) {
  return `${count} document${count === 1 ? "" : "s"}`;
}

// The part of a driver setting's key after "storage.<driverId>.", the same slicing
// DriverSettingField uses to label a field.
function settingShortKey(setting: ResolvedSetting) {
  return setting.key.split(".").slice(2).join(".");
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
    // A health check carries no reason for a failure, only a message, so it cannot be
    // the thing that flags a driver as needing reauthorization. It can, however, be
    // trusted to clear that flag: a driver that just answered is plainly not stuck.
    if (result.ok) clearStorageReauthRequired(queryClient, driverId);
    return result;
  }

  async function requestSwitch(driver: StorageDriverSummary) {
    const result = await runHealthCheck(driver.id);
    if (result.ok) setConfirmSwitch(driver);
  }

  if (drivers.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading storage drivers...</p>;
  }

  // The refresh token and account email are shown and managed through the connect and
  // disconnect controls below, not as generic fields someone would type into by hand.
  const driverSettings = selected
    ? settings
        .filter((s) => s.key.startsWith(`storage.${selected.id}.`))
        .filter((s) => !selected.redirectUri || !["refreshToken", "accountEmail"].includes(settingShortKey(s)))
    : [];
  const selectedTestResult = selected ? testResults[selected.id] : undefined;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
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
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
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
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-3">
                {selected.redirectUri && <RedirectUriNotice redirectUri={selected.redirectUri} />}

                {driverSettings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This driver needs no settings.</p>
                ) : (
                  driverSettings.map((setting) => (
                    <DriverSettingField key={setting.key} setting={setting} queryClient={queryClient} />
                  ))
                )}

                {selected.redirectUri && (
                  <DriverConnection driver={selected} driverSettings={driverSettings} queryClient={queryClient} />
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

  const shortKey = settingShortKey(setting);

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

// A mismatch on scheme, host or port in the redirect URI is the single most common way
// an OAuth driver's setup fails, so this stays visible and hard to miss above the fields.
function RedirectUriNotice({ redirectUri }: { redirectUri: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-900/20">
      <Label>Redirect URI to register</Label>
      <div className="flex flex-wrap items-center gap-2">
        <code className="flex-1 break-all rounded bg-background px-2 py-1 text-xs">{redirectUri}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { navigator.clipboard.writeText(redirectUri); toast.success("Copied"); }}
        >
          Copy
        </Button>
      </div>
      <p className="text-xs font-medium text-yellow-800 dark:text-yellow-400">
        Scheme, host and port must match exactly what is registered in Google Cloud. This is the most common way
        this setup fails.
      </p>
    </div>
  );
}

// Connect ends at the provider's consent screen, so it is a real navigation rather than
// a fetch. It stays disabled until the client id and secret this driver needs are both
// saved, since the flow cannot start without them.
function DriverConnection({
  driver,
  driverSettings,
  queryClient,
}: {
  driver: StorageDriverSummary;
  driverSettings: ResolvedSetting[];
  queryClient: QueryClient;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const needsReauth = useStorageReauthRequired(driver.id);

  const clientIdSetting = driverSettings.find((s) => settingShortKey(s) === "clientId");
  const clientSecretSetting = driverSettings.find((s) => settingShortKey(s) === "clientSecret");
  const hasClientId = typeof clientIdSetting?.value === "string" && clientIdSetting.value.length > 0;
  const hasClientSecret = Boolean((clientSecretSetting?.value as { isSet?: boolean } | undefined)?.isSet);
  const canConnect = hasClientId && hasClientSecret;

  const disconnect = useMutation({
    mutationFn: async () => {
      await settingsApi.update({
        [`storage.${driver.id}.refreshToken`]: null,
        [`storage.${driver.id}.accountEmail`]: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage-drivers"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setConfirmOpen(false);
      toast.success("Disconnected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (driver.accountEmail) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Connected as {driver.accountEmail}</span>
        {needsReauth && (
          <>
            <Badge variant="destructive">Needs reconnecting</Badge>
            <a href={`/api/storage/drivers/${driver.id}/connect`} className={buttonVariants({ size: "sm" })}>
              Reconnect
            </a>
          </>
        )}
        <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>Disconnect</Button>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect {driver.label}?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              DocMind stops being able to read or write files in this {driver.label} account until it is connected
              again. Files already stored there are not deleted.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                Disconnect {driver.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (!canConnect) {
    return (
      <Button size="sm" disabled title="Save the client id and secret first">
        Connect
      </Button>
    );
  }

  return (
    <a href={`/api/storage/drivers/${driver.id}/connect`} className={buttonVariants({ size: "sm" })}>
      Connect
    </a>
  );
}
