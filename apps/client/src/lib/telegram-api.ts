import { api } from "./api";

export type TelegramStatus = {
  tokenSet: boolean;
  paired: boolean;
  pairedName?: string;
  // Present only while unpaired and a bot token is set.
  pairingCode?: string;
};

export const telegramApi = {
  async status() {
    return api.get<TelegramStatus>("/api/telegram/status");
  },
  async requestPairingCode() {
    return api.json<{ pairingCode: string }>("POST", "/api/telegram/pairing-code", {});
  },
  async unpair() {
    return api.json<{ ok: true }>("POST", "/api/telegram/unpair", {});
  },
};
