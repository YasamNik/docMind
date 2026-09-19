import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { emailApi, type EmailTestResult } from "@/lib/email-api";
import { settingsApi, type ResolvedSetting } from "@/lib/settings-api";
import { GuideCard, type SetupGuide } from "./ProviderCard";

// The fields a person sets, in the order email.settings.ts registers them. lastError is
// internal and the settings list never returns it, so it has no place here.
const FIELD_KEYS = [
  "email.imap.host",
  "email.imap.port",
  "email.imap.user",
  "email.imap.password",
  "email.imap.folder",
  "email.imap.doneFolder",
  "email.imap.failedFolder",
  "email.imap.pollSeconds",
];

const NUMERIC_KEYS = new Set(["email.imap.port", "email.imap.pollSeconds"]);

const imapGuide: SetupGuide = {
  title: "Connect a mailbox over IMAP",
  intro: "DocMind checks one folder for new mail and turns each message into documents.",
  steps: [
    {
      text: "Create an app password for this mailbox. Gmail and most providers block sign in with the account password.",
      link: "https://myaccount.google.com/apppasswords",
    },
    {
      text: "In your mail client, create the folder DocMind will watch, for example DocMind, before saving these settings.",
    },
    { text: "Enter the host, port, mailbox address and app password below, then save each field." },
    { text: "Use Test to confirm DocMind can sign in and open the folder." },
  ],
  notes: [
    "DocMind only reads the folder named below. It never touches your inbox.",
    "A handled message moves to the done folder. DocMind never deletes a message.",
    "A message that keeps failing moves to the failed folder instead of being retried forever.",
  ],
};

// Turns a camelCase settings key into a short label: pollSeconds becomes Poll Seconds.
function fieldLabel(setting: ResolvedSetting) {
  const shortKey = setting.key.split(".").slice(2).join(".");
  const spaced = shortKey.replace(/([A-Z])/g, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function EmailTab() {
  const queryClient = useQueryClient();
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.list(),
  });

  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);

  const test = useMutation({
    mutationFn: () => emailApi.test(),
    onSuccess: (result) => setTestResult(result),
    onError: (e: Error) => setTestResult({ ok: false, message: e.message }),
  });

  const fields = FIELD_KEYS.map((key) => settings.find((s) => s.key === key)).filter(
    (s): s is ResolvedSetting => Boolean(s),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading email settings...</p>
            ) : (
              fields.map((setting) => (
                <EmailSettingField key={setting.key} setting={setting} queryClient={queryClient} />
              ))
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                {test.isPending ? "Testing..." : "Test"}
              </Button>
              {testResult && (
                <span className={`text-sm ${testResult.ok ? "text-org-accent2-700" : "text-destructive"}`}>
                  {testResult.message}
                </span>
              )}
            </div>
          </div>

          <GuideCard guide={imapGuide} />
        </div>
      </CardContent>
    </Card>
  );
}

function EmailSettingField({ setting, queryClient }: { setting: ResolvedSetting; queryClient: QueryClient }) {
  const [value, setValue] = useState("");
  const isNumeric = NUMERIC_KEYS.has(setting.key);
  const maskedInitial = setting.secret ? (setting.value as { isSet: boolean } | undefined) : undefined;
  const [editing, setEditing] = useState(setting.secret ? !maskedInitial?.isSet : false);

  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [setting.key]: isNumeric ? Number(value) : value });
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

  const label = fieldLabel(setting);

  if (setting.secret) {
    const masked = setting.value as { isSet: boolean; lastFour?: string };
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{setting.doc}</p>
        {masked.isSet && !editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Set, ends in {masked.lastFour ? `····${masked.lastFour}` : "****"}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setValue("");
                setEditing(true);
              }}
            >
              Replace
            </Button>
            <Button size="sm" variant="outline" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Clear
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              placeholder="Paste the app password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button size="sm" onClick={() => save.mutate()} disabled={!value || save.isPending}>
              Save
            </Button>
            {masked.isSet && (
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <p className="text-xs text-muted-foreground">{setting.doc}</p>
      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{String(setting.value ?? "(not set)")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setValue(String(setting.value ?? ""));
              setEditing(true);
            }}
          >
            Edit
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Input type={isNumeric ? "number" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
