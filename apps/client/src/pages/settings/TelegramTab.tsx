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

export function TelegramTab() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ["telegram-status"],
    queryFn: () => telegramApi.status(),
  });

  const [tokenInput, setTokenInput] = useState("");
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  function invalidateStatus() {
    queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
  }

  const saveToken = useMutation({
    mutationFn: async () => {
      await settingsApi.update({ "telegram.botToken": tokenInput });
    },
    onSuccess: () => {
      invalidateStatus();
      setTokenInput("");
      toast.success("Token saved");
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.tokenSet && (
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
              </div>
            </div>
            <GuideCard guide={botFatherGuide} />
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
    </Card>
  );
}
