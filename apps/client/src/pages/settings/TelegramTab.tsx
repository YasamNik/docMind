import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { telegramApi } from "@/lib/telegram-api";
import { settingsApi } from "@/lib/settings-api";
import { GuideCard, type SetupGuide } from "./ProviderCard";

const botFatherGuide: SetupGuide = {
  title: "Create a bot with BotFather",
  intro: "Takes about a minute, and needs nothing but a Telegram account.",
  steps: [
    { text: "Open Telegram and message @BotFather.", link: "https://t.me/BotFather" },
    { text: "Send /newbot." },
    { text: "Pick a display name and a username ending in bot." },
    { text: "Copy the token it replies with." },
    { text: "Paste it below." },
  ],
  notes: ["Keep the token private. Anyone who has it can send messages as your bot."],
};

const TOKEN_SETTING_KEY = "telegram.botToken";

export function TelegramTab() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["telegram-status"],
    queryFn: () => telegramApi.status(),
  });
  // telegram.botToken is registered as a secret setting, the same registry StorageTab
  // reads from, so its resolved value already arrives masked and this list is the only
  // way to get the last four digits shown next to Replace.
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.list(),
  });

  const [tokenInput, setTokenInput] = useState("");
  const [replacingToken, setReplacingToken] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [confirmClearToken, setConfirmClearToken] = useState(false);

  function invalidateStatus() {
    queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
  }
  function invalidateSettings() {
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  }

  const saveToken = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [TOKEN_SETTING_KEY]: tokenInput });
    },
    onSuccess: () => {
      invalidateStatus();
      invalidateSettings();
      setTokenInput("");
      setReplacingToken(false);
      toast.success("Token saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clearToken = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ [TOKEN_SETTING_KEY]: null });
      // A cleared token cannot reach the bot, so a pairing left over from before is
      // just a confusing dead end: unpair alongside the clear so the next thing
      // anyone sees is the plain no-token state, not a paired account with nothing
      // to pair it to.
      await telegramApi.unpair();
    },
    onSuccess: () => {
      invalidateStatus();
      invalidateSettings();
      setConfirmClearToken(false);
      toast.success("Token cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const newCode = useMutation({
    mutationFn: () => telegramApi.requestPairingCode(),
    onSuccess: invalidateStatus,
    onError: (e: Error) => toast.error(e.message),
  });

  const unpair = useMutation({
    mutationFn: () => telegramApi.unpair(),
    onSuccess: () => {
      invalidateStatus();
      setConfirmUnpair(false);
      toast.success("Unpaired");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading Telegram status...</p>;
  }

  const tokenSetting = settings.find((s) => s.key === TOKEN_SETTING_KEY);
  // Falls back to status.tokenSet when the settings list has not resolved the entry
  // yet, so the masked view still shows correctly, just without the last four digits.
  const maskedToken = (tokenSetting?.value as { isSet: boolean; lastFour?: string } | undefined) ?? {
    isSet: status.tokenSet,
  };
  const showTokenForm = !status.tokenSet || replacingToken;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {showTokenForm ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Bot token</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="password"
                  placeholder="Paste the token from BotFather"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
                <Button size="sm" onClick={() => saveToken.mutate()} disabled={!tokenInput || saveToken.isPending}>
                  Save
                </Button>
                {status.tokenSet && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setTokenInput("");
                      setReplacingToken(false);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
            <GuideCard guide={botFatherGuide} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>Bot token</Label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Set, ends in {maskedToken.lastFour ? `····${maskedToken.lastFour}` : "****"}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setTokenInput("");
                  setReplacingToken(true);
                }}
              >
                Replace
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmClearToken(true)}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {status.tokenSet && !status.paired && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Send that code to your bot as a normal message. It ignores everyone else until then.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-3 py-1.5 text-lg font-mono tracking-widest">
                {status.pairingCode}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(status.pairingCode ?? "");
                  toast.success("Copied");
                }}
              >
                Copy
              </Button>
            </div>
            <Button size="sm" variant="outline" onClick={() => newCode.mutate()} disabled={newCode.isPending}>
              Get a new code
            </Button>
          </div>
        )}

        {status.tokenSet && status.paired && (
          <div className="space-y-3">
            <p className="text-sm">Paired with {status.pairedName ?? "a Telegram account"}.</p>
            <Button size="sm" variant="destructive" onClick={() => setConfirmUnpair(true)}>
              Unpair
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={confirmUnpair} onOpenChange={setConfirmUnpair}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unpair Telegram?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The bot stops accepting anything until it is paired again.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUnpair(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => unpair.mutate()} disabled={unpair.isPending}>
              Unpair Telegram
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClearToken} onOpenChange={setConfirmClearToken}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear the bot token?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This also drops the pairing. The bot stops responding until a new token is set and paired again.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClearToken(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => clearToken.mutate()} disabled={clearToken.isPending}>
              Clear token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
