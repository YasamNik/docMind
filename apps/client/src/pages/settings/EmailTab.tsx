import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { emailApi, type EmailStatus, type EmailTestResult } from "@/lib/email-api";
import { settingsApi, type ResolvedSetting } from "@/lib/settings-api";
import { GuideCard, type SetupGuide } from "./ProviderCard";

// The settings the mailbox behaves by, whichever mode is active: watched folder, where
// a message lands after it is handled, poll interval and the size cap. Shown once a
// mode is actually configured, gmail or password, never before.
const MAILBOX_FIELD_KEYS = [
  "email.imap.folder",
  "email.imap.doneFolder",
  "email.imap.failedFolder",
  "email.imap.pollSeconds",
  "email.imap.maxMessageSizeMb",
];

// The settings only a non-Gmail IMAP connection needs. Tucked behind a disclosure so a
// Gmail user never has to look at them.
const CONNECTION_FIELD_KEYS = [
  "email.imap.host",
  "email.imap.port",
  "email.imap.user",
  "email.imap.password",
];

const NUMERIC_KEYS = new Set(["email.imap.port", "email.imap.pollSeconds", "email.imap.maxMessageSizeMb"]);

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

// Only the two clicks Google actually requires beyond pressing Connect: turning the
// API on, and adding the one scope IMAP needs. Google's own console walkthrough for
// registering an app at all lives on the Storage tab and is not repeated here.
const gmailGuide: SetupGuide = {
  title: "Connect Gmail",
  intro: "Two changes in Google Cloud, then press Connect Gmail.",
  steps: [
    { text: "Turn on the Gmail API.", link: "https://console.cloud.google.com/apis/library/gmail.googleapis.com" },
    {
      text: "Add https://mail.google.com/ as a scope for this app, under Data Access on the OAuth consent screen.",
      link: "https://console.cloud.google.com/auth/scopes",
    },
    { text: "Press Connect Gmail above." },
  ],
  notes: [
    "Google's consent screen will claim DocMind can read, send and delete your mail because IMAP has no narrower scope to ask for, but DocMind only reads the folder set below and moves messages within it, and never sends or deletes anything.",
    "While this Google app is in Testing, Google expires the Gmail connection about once a week, and the banner on this tab will say when that happens.",
  ],
};

// Shown once Gmail is connected. The setup steps are done, so repeating them, or worse
// falling back to the app password guide, only tells a signed in user to go and do
// something they do not need.
const gmailConnectedGuide: SetupGuide = {
  title: "Gmail is connected",
  intro: "DocMind checks the folder below for new mail and turns each message into documents.",
  steps: [],
  notes: [
    "DocMind only reads the folder named below. It never touches your inbox.",
    "A handled message moves to the done folder. DocMind never deletes a message.",
    "A message that keeps failing moves to the failed folder instead of being retried forever.",
    "While this Google app is in Testing, Google expires the connection about once a week. The banner here will say when that happens.",
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
  const { data: status } = useQuery({
    queryKey: ["email-status"],
    queryFn: () => emailApi.status(),
  });

  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);

  const test = useMutation({
    mutationFn: () => emailApi.test(),
    onSuccess: (result) => setTestResult(result),
    onError: (e: Error) => setTestResult({ ok: false, message: e.message }),
  });

  const fieldByKey = (key: string) => settings.find((s) => s.key === key);
  const mailboxFields = MAILBOX_FIELD_KEYS.map(fieldByKey).filter((s): s is ResolvedSetting => Boolean(s));
  const connectionFields = CONNECTION_FIELD_KEYS.map(fieldByKey).filter((s): s is ResolvedSetting => Boolean(s));

  if (!status || settings.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading email settings...</p>
        </CardContent>
      </Card>
    );
  }

  // Redirecting to Google is only ever relevant while a connect or a reconnect is on
  // offer: an already healthy connection has nothing to register again.
  const showsRedirectUri = status.needsReconnect || (status.mode === "unconfigured" && status.googleAppAvailable);
  // A connected Gmail mailbox must never be shown the app password guide: it is wrong
  // for that mode, and it is the text the user could not follow in the first place.
  const guide =
    status.mode === "gmail"
      ? gmailConnectedGuide
      : status.mode === "unconfigured" && status.googleAppAvailable
        ? gmailGuide
        : imapGuide;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {status.needsReconnect ? (
              <ReconnectBanner />
            ) : status.mode === "gmail" ? (
              <GmailConnection status={status} queryClient={queryClient} />
            ) : status.mode === "unconfigured" ? (
              status.googleAppAvailable ? (
                <ConnectGmail />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No Google app is set up yet. Open the Storage tab and connect Google Drive first, and Gmail
                  will reuse that same app.
                </p>
              )
            ) : null}

            {showsRedirectUri && <RedirectUriNotice redirectUri={status.redirectUri} />}

            {status.mode !== "unconfigured" &&
              mailboxFields.map((setting) => (
                <EmailSettingField key={setting.key} setting={setting} queryClient={queryClient} />
              ))}

            <details className="rounded-lg border border-input" open={status.mode === "password"}>
              <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium">
                Not on Gmail? Connect another mailbox
              </summary>
              <div className="space-y-3 border-t border-input p-3">
                {connectionFields.map((setting) => (
                  <EmailSettingField key={setting.key} setting={setting} queryClient={queryClient} />
                ))}
              </div>
            </details>

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

          <GuideCard guide={guide} />
        </div>
      </CardContent>
    </Card>
  );
}

// Says plainly that intake has stopped and gives the one action that fixes it. Only
// shown for a Gmail grant that has expired or been revoked, the one case
// email.imap.lastErrorCode actually tracks.
function ReconnectBanner() {
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
      <p className="text-sm font-medium text-destructive">
        Mail collection has stopped. Gmail access has expired or been revoked.
      </p>
      <a href="/api/email/gmail/connect" className={buttonVariants({ size: "sm" })}>
        Reconnect Gmail
      </a>
    </div>
  );
}

// The whole first step: one button, and the one sentence the user asked to see next to
// it, that this reuses Drive's own app rather than asking to set up a second one.
function ConnectGmail() {
  return (
    <div className="space-y-2">
      <a href="/api/email/gmail/connect" className={buttonVariants({ size: "sm" })}>
        Connect Gmail
      </a>
      <p className="text-sm text-muted-foreground">
        This connects using the Google app already set up for Google Drive, so there is nothing new to
        configure.
      </p>
    </div>
  );
}

// A mismatch on scheme, host or port in the redirect URI is the single most common way
// an OAuth setup fails, and the tunnel address this depends on changes on its own.
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
        Must match exactly what is registered in Google Cloud. Check this again after the tunnel address
        changes.
      </p>
    </div>
  );
}

function GmailConnection({ status, queryClient }: { status: EmailStatus; queryClient: QueryClient }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const disconnect = useMutation({
    mutationFn: async () => {
      await settingsApi.update({
        "email.gmail.refreshToken": null,
        "email.gmail.accountEmail": null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-status"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setConfirmOpen(false);
      toast.success("Disconnected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">Connected as {status.connectedAs}</span>
      <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
        Disconnect
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Gmail?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            DocMind stops checking this Gmail account for mail until it is connected again. Mail already taken
            in is not affected.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              Disconnect Gmail
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
