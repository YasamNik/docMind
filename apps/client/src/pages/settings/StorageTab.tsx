import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { settingsApi, type ResolvedSetting } from "@/lib/settings-api";

export function StorageTab() {
  const queryClient = useQueryClient();
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.list(),
  });

  const storageSettings = settings.filter((s) => s.key.startsWith("storage."));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {storageSettings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No storage settings found.</p>
          ) : (
            storageSettings.map((setting) => (
              <StorageField key={setting.key} setting={setting} queryClient={queryClient} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StorageField({ setting, queryClient }: { setting: ResolvedSetting; queryClient: ReturnType<typeof useQueryClient> }) {
  const [value, setValue] = useState(String(setting.value ?? ""));
  const [editing, setEditing] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [setting.key]: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setEditing(false);
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shortKey = setting.key.replace(/^storage\./, "");

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
